import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobHashes, repoPath, repoText, trackedFiles } from "@grenier/connectors/git";
import {
  askCodebase,
  type CacheDeps,
  CacheError,
  checkSummary,
  type Embedder,
  fileSummary,
  type Repo,
  recordAnswer,
  recordSummary,
  repoMap,
  terms,
} from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Gives each listed text a fixed direction, so a test decides which questions are alike. Others get zeros. */
class TableEmbedder implements Embedder {
  readonly model = "table";
  readonly dimensions = 3;
  constructor(readonly table: Record<string, [number, number, number]>) {}
  async embed(texts: readonly string[]) {
    return texts.map((text) => Float32Array.from(this.table[text] ?? [0, 0, 0]));
  }
}

let dir: string;
let store: Store;
let repo: Repo;

function write(path: string, content: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function git(...args: string[]) {
  execFileSync("git", ["-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x.invalid",
    },
  });
}

function deps(embedder: Embedder | null = null): CacheDeps {
  return {
    store,
    embedder,
    files: { hashes: blobHashes, tracked: trackedFiles, relative: repoPath, text: repoText },
    now: () => 1_000,
  };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-cache-")));
  git("init", "-q");
  write("src/proxy.ts", "export function proxy() {}\n");
  write("src/budget.ts", "export function budget() {}\n");
  write("README.md", "# app\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  store = openSqliteStore(":memory:");
  repo = { root: dir, id: "repo-1" };
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const STREAM_Q = "How does the proxy stream responses back to the client?";
const STREAM_A = "src/proxy.ts pipes the upstream body through a TransformStream that reads usage on the way.";

describe("record_answer and ask_codebase", () => {
  it("is a hit for the same question while the files are unchanged, and counts the reuse", async () => {
    const { id } = await recordAnswer(deps(), repo, { question: STREAM_Q, answer: STREAM_A, files: ["src/proxy.ts"] });

    const result = await askCodebase(deps(), repo, { question: STREAM_Q });

    expect(result).toMatchObject({ status: "hit", id, answer: STREAM_A, question: STREAM_Q, changed: [] });
    expect(result.sources).toEqual([{ path: "src/proxy.ts", blobHash: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
    expect((await store.answers.get(id))?.hits).toBe(1);
  });

  it("is stale, with the changed paths, once a source file is edited or deleted", async () => {
    await recordAnswer(deps(), repo, { question: STREAM_Q, answer: STREAM_A, files: ["src/proxy.ts", "README.md"] });

    write("src/proxy.ts", "export function proxy() { return 1; }\n");
    expect(await askCodebase(deps(), repo, { question: STREAM_Q })).toMatchObject({
      status: "stale",
      changed: ["src/proxy.ts"],
    });

    unlinkSync(join(dir, "README.md"));
    expect((await askCodebase(deps(), repo, { question: STREAM_Q })).changed).toEqual(["README.md", "src/proxy.ts"]);
  });

  it("is a hit again once the file is back as it was", async () => {
    await recordAnswer(deps(), repo, { question: STREAM_Q, answer: STREAM_A, files: ["src/proxy.ts"] });
    write("src/proxy.ts", "changed\n");
    write("src/proxy.ts", "export function proxy() {}\n");
    expect((await askCodebase(deps(), repo, { question: STREAM_Q })).status).toBe("hit");
  });

  it("is a miss for an unrelated question, or in another repository", async () => {
    await recordAnswer(deps(), repo, { question: STREAM_Q, answer: STREAM_A, files: ["src/proxy.ts"] });
    expect((await askCodebase(deps(), repo, { question: "What licence does the project use?" })).status).toBe("miss");
    expect((await askCodebase(deps(), { ...repo, id: "other" }, { question: STREAM_Q })).status).toBe("miss");
  });

  it("finds a reworded question by full text when it shares two terms, stemmed", async () => {
    await recordAnswer(deps(), repo, { question: STREAM_Q, answer: STREAM_A, files: ["src/proxy.ts"] });
    const reworded = "Which code streams the proxied responses?";
    expect((await askCodebase(deps(), repo, { question: reworded })).status).toBe("hit");
    expect((await askCodebase(deps(), repo, { question: "Where is the client?" })).status).toBe("miss");
  });

  it("finds a reworded question with no word in common by its vector", async () => {
    const reworded = "Where does output get relayed while it is generated?";
    const embedder = new TableEmbedder({ [STREAM_Q]: [1, 0.1, 0], [reworded]: [0.9, 0.2, 0.1], unrelated: [0, 0, 1] });
    await recordAnswer(deps(embedder), repo, { question: STREAM_Q, answer: STREAM_A, files: ["src/proxy.ts"] });

    expect((await askCodebase(deps(embedder), repo, { question: reworded })).status).toBe("hit");
    expect((await askCodebase(deps(embedder), repo, { question: "unrelated" })).status).toBe("miss");
    expect((await askCodebase(deps(null), repo, { question: reworded })).status).toBe("miss");
  });

  it("prefers the answer both searches agree on", async () => {
    const budgetQ = "Where are budgets checked before forwarding?";
    const embedder = new TableEmbedder({
      [STREAM_Q]: [1, 0, 0],
      [budgetQ]: [0, 1, 0],
      "budgets checked where": [0, 1, 0],
    });
    await recordAnswer(deps(embedder), repo, { question: STREAM_Q, answer: STREAM_A, files: ["src/proxy.ts"] });
    const { id } = await recordAnswer(deps(embedder), repo, {
      question: budgetQ,
      answer: "src/budget.ts, before the proxy forwards.",
      files: ["src/budget.ts"],
    });
    expect((await askCodebase(deps(embedder), repo, { question: "budgets checked where" })).id).toBe(id);
  });

  it("replaces an earlier answer to the same question", async () => {
    await recordAnswer(deps(), repo, { question: STREAM_Q, answer: "old", files: ["src/proxy.ts"] });
    await recordAnswer(deps(), repo, {
      question: `  ${STREAM_Q.toUpperCase()} `,
      answer: "new",
      files: ["src/proxy.ts"],
    });
    expect((await askCodebase(deps(), repo, { question: STREAM_Q })).answer).toBe("new");
    expect(await store.answers.stats()).toEqual([{ repoId: "repo-1", answers: 1, hits: 1 }]);
  });

  it("refuses files outside the repository, missing files, and empty fields", async () => {
    const record = (files: string[], question = STREAM_Q, answer = STREAM_A) =>
      recordAnswer(deps(), repo, { question, answer, files });
    await expect(record(["../outside.ts"])).rejects.toThrow(CacheError);
    await expect(record(["/etc/passwd"])).rejects.toThrow("is outside the repository");
    await expect(record(["src/nope.ts"])).rejects.toThrow("no such file: src/nope.ts");
    await expect(record([])).rejects.toThrow("list the files");
    await expect(record(["src/proxy.ts"], " ")).rejects.toThrow("must not be empty");
  });

  it("refuses what the team server would refuse: a long answer or question, or too much quoted code", async () => {
    const record = (question: string, answer: string) =>
      recordAnswer(deps(), repo, { question, answer, files: ["src/proxy.ts"] });
    await expect(record(STREAM_Q, "x".repeat(4001))).rejects.toThrow(
      "the answer is refused: it holds at most 4000 characters",
    );
    await expect(record(STREAM_Q, `\`\`\`ts\n${"line\n".repeat(11)}\`\`\``)).rejects.toThrow(
      "it may quote at most 10 lines of code",
    );
    await expect(record("q".repeat(2001), STREAM_A)).rejects.toThrow("the question holds at most 2000 characters");
    expect(await store.answers.stats()).toEqual([]);
  });

  it("refuses an answer or a summary that copies more than ten lines of a source file, fenced or not", async () => {
    const code = Array.from({ length: 30 }, (_, line) => `  const value${line} = compute(${line});`).join("\n");
    write("src/long.ts", `${code}\n`);
    const copied = `It starts like this:\n${code.split("\n").slice(5, 17).join("\n")}\nand goes on.`;
    await expect(
      recordAnswer(deps(), repo, { question: "What does long.ts do?", answer: copied, files: ["src/long.ts"] }),
    ).rejects.toThrow("the answer is refused: it copies 12 lines of src/long.ts");
    await expect(recordSummary(deps(), repo, { path: "src/long.ts", summary: copied })).rejects.toThrow(
      "the summary is refused: it copies 12 lines of src/long.ts",
    );

    const snippet = `It computes values, as in:\n${code.split("\n").slice(0, 10).join("\n")}`;
    await expect(
      recordAnswer(deps(), repo, { question: "What does long.ts do?", answer: snippet, files: ["src/long.ts"] }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("takes absolute paths inside the repository", async () => {
    await recordAnswer(deps(), repo, { question: STREAM_Q, answer: STREAM_A, files: [join(dir, "src/proxy.ts")] });
    expect((await askCodebase(deps(), repo, { question: STREAM_Q })).sources[0]?.path).toBe("src/proxy.ts");
  });
});

describe("summaries and repo_map", () => {
  it("returns a file's summary while its content is the one summarised", async () => {
    expect((await fileSummary(deps(), repo, { path: "src/proxy.ts" })).status).toBe("miss");
    await recordSummary(deps(), repo, { path: "src/proxy.ts", summary: "Forwards requests to the upstream." });

    expect(await fileSummary(deps(), repo, { path: "src/proxy.ts" })).toEqual({
      status: "hit",
      path: "src/proxy.ts",
      summary: "Forwards requests to the upstream.",
    });
    write("src/proxy.ts", "changed\n");
    expect((await fileSummary(deps(), repo, { path: "src/proxy.ts" })).status).toBe("miss");
  });

  it("maps the top level, with directory summaries that go stale when a tracked file changes", async () => {
    await recordSummary(deps(), repo, { path: "src", summary: "The proxy and the budgets." });

    expect(await repoMap(deps(), repo)).toEqual({
      entries: [
        { path: "src", kind: "directory", files: 2, summary: "The proxy and the budgets.", stale: false },
        { path: "README.md", kind: "file", files: 1 },
      ],
    });

    write("src/budget.ts", "changed\n");
    git("add", ".");
    expect((await repoMap(deps(), repo)).entries[0]?.stale).toBe(true);
  });

  it("refuses a summary that quotes too much code, or a path that does not exist", async () => {
    const long = `Intro\n\`\`\`ts\n${"line\n".repeat(11)}\`\`\``;
    expect(() => checkSummary(long)).toThrow("the summary is refused: it may quote at most 10 lines of code");
    expect(() => checkSummary("x".repeat(4001))).toThrow("at most 4000 characters");
    expect(() => checkSummary(`\`\`\`ts\n${"line\n".repeat(10)}\`\`\``)).not.toThrow();
    await expect(recordSummary(deps(), repo, { path: "nope", summary: "x" })).rejects.toThrow(
      "no such file or directory",
    );
  });
});

describe("terms", () => {
  it("keeps the words worth searching for", () => {
    expect(terms("How does the Proxy stream, and stream again?")).toEqual(["proxy", "stream", "again"]);
  });
});
