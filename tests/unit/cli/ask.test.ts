import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobHashes, repoId, repoPath, trackedFiles } from "@grenier/connectors/git";
import { type Embedder, recordAnswer } from "@grenier/index";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../../apps/cli/src/cli.ts";
import { promptHook } from "../../../apps/cli/src/commands/ask.ts";
import type { Io } from "../../../apps/cli/src/io.ts";

class TableEmbedder implements Embedder {
  readonly model = "table";
  readonly dimensions = 2;
  constructor(readonly table: Record<string, [number, number]>) {}
  async embed(texts: readonly string[]) {
    return texts.map((text) => Float32Array.from(this.table[text] ?? [0, 0]));
  }
}

const QUESTION = "How does the proxy stream responses back?";
const ANSWER = "src/proxy.ts pipes the upstream body through a TransformStream.";

let dir: string;
let home: string;
let id: string;

function io(out: string[], stdin = ""): Io {
  return {
    env: { GRENIER_HOME: home },
    cwd: dir,
    out: (line) => out.push(line),
    err: () => {},
    self: [],
    stdin: async () => stdin,
  };
}

async function record(embedder: Embedder | null) {
  const store = openSqliteStore(join(home, "grenier.db"));
  try {
    const repo = { root: dir, id: (await repoId(dir)) as string };
    const files = { hashes: blobHashes, tracked: trackedFiles, relative: repoPath };
    ({ id } = await recordAnswer({ store, embedder, files }, repo, {
      question: QUESTION,
      answer: ANSWER,
      files: ["src/proxy.ts"],
    }));
  } finally {
    await store.close();
  }
}

async function hits() {
  const store = openSqliteStore(join(home, "grenier.db"));
  try {
    return (await store.answers.get(id))?.hits;
  } finally {
    await store.close();
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-ask-")));
  home = join(dir, ".home");
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), '[cache]\nembeddings = "off"\n');
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "proxy.ts"), "export function proxy() {}\n");
  writeFileSync(join(dir, ".gitignore"), ".home\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x.invalid" };
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: { ...env, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x.invalid" },
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "first");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("grenier ask", () => {
  it("prints the recorded answer with where it came from, and counts the reuse", async () => {
    await record(null);
    const out: string[] = [];
    expect(await run(["ask", "how", "does", "the", "proxy", "stream", "responses?"], io(out))).toBe(0);
    expect(out.join("\n")).toBe(
      [
        ANSWER,
        "",
        `Recorded for: ${QUESTION}`,
        "From: src/proxy.ts",
        `Id: ${id} (grenier cache forget ${id} removes it)`,
      ].join("\n"),
    );
    expect(await hits()).toBe(1);
  });

  it("says when the files changed since, or when nothing is recorded", async () => {
    await record(null);
    writeFileSync(join(dir, "src", "proxy.ts"), "changed\n");
    const out: string[] = [];
    await run(["ask", QUESTION], io(out));
    expect(out[0]).toMatch(/^Stale: src\/proxy.ts changed since it was recorded/);

    const none: string[] = [];
    await run(["ask", "What licence is it under?"], io(none));
    expect(none).toEqual(["Nothing is recorded for this question yet."]);
  });

  it("fails with a plain message outside a git repository", async () => {
    const err: string[] = [];
    const outside = { ...io([]), err: (line: string) => err.push(line) };
    expect(await run(["ask", "--repo", tmpdir(), "anything"], outside)).toBe(1);
    expect(err.join("\n")).toMatch(/^grenier: not inside a git repository: /);
  });

  it("forgets an answer by its id", async () => {
    await record(null);
    const out: string[] = [];
    expect(await run(["cache", "forget", id], io(out))).toBe(0);
    expect(out).toEqual([`Forgot answer ${id}.`]);
    expect(await run(["cache", "forget", id], io([]))).toBe(1);
  });
});

describe("grenier hook prompt", () => {
  const PROMPT = "walk me through how streaming works in the proxy";
  const embedder = new TableEmbedder({ [QUESTION]: [1, 0], [PROMPT]: [0.95, 0.3], "add a logo": [0, 1] });
  const input = (prompt: string, cwd = dir) => JSON.stringify({ prompt, cwd, hook_event_name: "UserPromptSubmit" });

  it("passes the agent an unchanged answer close to the prompt, without counting a reuse", async () => {
    await record(embedder);
    const out: string[] = [];
    expect(await promptHook(io(out, input(PROMPT)), embedder)).toBe(0);
    const output = JSON.parse(out.join(""));
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toContain(`Answer: ${ANSWER}`);
    expect(output.hookSpecificOutput.additionalContext).toContain("Files: src/proxy.ts");
    expect(await hits()).toBe(0);
  });

  it("prints nothing for a distant prompt, a stale answer, no embeddings, outside a repository, or bad input", async () => {
    await record(embedder);
    const silent = async (stdin: string, vectors: Embedder | null = embedder) => {
      const out: string[] = [];
      expect(await promptHook(io(out, stdin), vectors)).toBe(0);
      return out;
    };
    expect(await silent(input("add a logo"))).toEqual([]);
    expect(await silent(input(PROMPT), null)).toEqual([]);
    expect(await silent(input(PROMPT, tmpdir()))).toEqual([]);
    expect(await silent("not json")).toEqual([]);
    writeFileSync(join(dir, "src", "proxy.ts"), "changed\n");
    expect(await silent(input(PROMPT))).toEqual([]);
  });
});
