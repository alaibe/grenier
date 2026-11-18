import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeEdits, shellSteps, stepsOf, type ToolUse } from "@grenier/gateway";
import type { NewStep } from "@grenier/store";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fakeUpstream, fixture, messagesRequest, sse, type TestGateway, testGateway } from "../../support/gateway.ts";

// A real directory: a shell word becomes a path only if it exists there.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "grenier-trace-")));
mkdirSync(join(ROOT, "src"));
for (const file of ["a.ts", "b.ts", "src/trace.ts"]) writeFileSync(join(ROOT, file), "export {};\n");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const session = { id: "s1", repoRoot: ROOT, cwd: ROOT };

let counter = 0;
const use = (tool: string, input: unknown, result?: ToolUse["result"]): ToolUse => ({
  id: `call-${++counter}`,
  tool,
  input,
  ...(result ? { result } : {}),
});

const steps = (...uses: ToolUse[]) =>
  stepsOf(session, uses, 1_000).map(({ kind, path, startLine, endLine, label, outcome }) => ({
    kind,
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(label === undefined ? {} : { label }),
    ...(outcome === undefined ? {} : { outcome }),
  }));

describe("the steps of Claude Code's tools", () => {
  it("reads a line range, or a whole file, inside the repository only", () => {
    expect(
      steps(
        use("Read", { file_path: `${ROOT}/src/proxy.ts`, offset: 60, limit: 41 }),
        use("Read", { file_path: `${ROOT}/README.md` }),
        use("Read", { file_path: "/etc/hosts" }),
        use("Read", { file_path: `${ROOT}/../other/secret.ts` }),
      ),
    ).toEqual([
      { kind: "read", path: "src/proxy.ts", startLine: 60, endLine: 100 },
      { kind: "read", path: "README.md" },
    ]);
  });

  it("places an edit on the lines its result shows, and a write over the whole file", () => {
    const shown =
      "The file has been updated. Here's the result:\n    12→const a = 1;\n    13→const b = 2;\n    15\tend";
    expect(
      steps(
        use("Edit", { file_path: `${ROOT}/src/a.ts`, old_string: "x", new_string: "y" }, { error: false, text: shown }),
        use("Write", { file_path: `${ROOT}/src/new.ts`, content: "one\ntwo\nthree" }),
        use("MultiEdit", { file_path: `${ROOT}/src/b.ts`, edits: [] }, { error: true, text: "String not found" }),
      ),
    ).toEqual([
      { kind: "edit", path: "src/a.ts", startLine: 12, endLine: 15 },
      { kind: "edit", path: "src/new.ts", startLine: 1, endLine: 3 },
      { kind: "edit", path: "src/b.ts", outcome: "error" },
    ]);
  });

  it("searches and lists from the working directory, keeping a short pattern without anything like a key", () => {
    expect(
      steps(
        use("Grep", { pattern: "LoopWatch", path: `${ROOT}/packages/gateway` }),
        use("Grep", { pattern: "sk-ant-api03-abcdefghijklmnop1234567890" }),
        use("Glob", { pattern: "**/*.test.ts" }),
        use("Grep", { pattern: "x", path: "/tmp" }),
      ),
    ).toEqual([
      { kind: "search", path: "packages/gateway", label: "LoopWatch" },
      { kind: "search", path: null, label: "[removed]" },
      { kind: "list", path: null, label: "**/*.test.ts" },
    ]);
  });

  it("shortens a long label", () => {
    const [step] = steps(use("Grep", { pattern: "word ".repeat(40) }));
    expect(step?.label).toHaveLength(80);
    expect(step?.label?.endsWith("…")).toBe(true);
  });

  it("numbers the steps of one call and stamps them with the session and time", () => {
    const [first, second] = stepsOf(session, [use("Bash", { command: "cat a.ts b.ts" })], 42);
    expect(first).toMatchObject({ sessionId: "s1", ts: 42, tool: "Bash", part: 0, path: "a.ts" });
    expect(second).toMatchObject({ part: 1, path: "b.ts" });
  });
});

describe("the steps of a shell command", () => {
  const shell = (command: string | string[], cwd = ROOT) =>
    shellSteps({ root: ROOT, cwd }, command).map(({ kind, path, startLine, endLine, label }) => ({
      kind,
      path,
      ...(startLine === undefined ? {} : { startLine, endLine }),
      ...(label === undefined ? {} : { label }),
    }));

  it("reads files with cat, head and sed -n, and a pipeline's range", () => {
    expect(shell("sed -n '10,40p' src/proxy.ts && head -n 20 README.md")).toEqual([
      { kind: "read", path: "src/proxy.ts", startLine: 10, endLine: 40 },
      { kind: "read", path: "README.md", startLine: 1, endLine: 20 },
    ]);
    expect(shell("nl -ba src/loops.ts | sed -n '5,9p'")).toEqual([
      { kind: "read", path: "src/loops.ts", startLine: 5, endLine: 9 },
    ]);
  });

  it("follows cd, and leaves out what is outside the repository", () => {
    expect(shell("cd packages/gateway && cat src/trace.ts /etc/passwd; ls")).toEqual([
      { kind: "read", path: "packages/gateway/src/trace.ts" },
      { kind: "list", path: "packages/gateway" },
    ]);
  });

  it("searches with rg, grep and git grep, scoped to their paths", () => {
    expect(shell('rg -n -g "*.ts" "toolCalls(" packages/gateway tests')).toEqual([
      { kind: "search", path: "packages/gateway", label: "toolCalls(" },
      { kind: "search", path: "tests", label: "toolCalls(" },
    ]);
    expect(shell("git grep -e needle")).toEqual([{ kind: "search", path: null, label: "needle" }]);
    expect(shell('grep -n "schema 8" tests/e2e/*.ts')).toEqual([
      { kind: "search", path: "tests/e2e", label: "schema 8" },
    ]);
  });

  it("reads a Codex command array, and the files of a patch", () => {
    expect(shell(["bash", "-lc", "cat src/a.ts | head -n 5"])).toEqual([
      { kind: "read", path: "src/a.ts", startLine: 1, endLine: 5 },
    ]);
    expect(
      shell(
        "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+x\n*** End Patch\nEOF",
      ),
    ).toEqual([
      { kind: "edit", path: "src/a.ts" },
      { kind: "edit", path: "src/b.ts" },
    ]);
  });

  it("takes sed -i '' as a change, redirections as reads and writes, and no heredoc body as commands", () => {
    expect(shell("sed -i '' 's/(schema 8)/(schema 9)/' src/a.ts")).toEqual([{ kind: "edit", path: "src/a.ts" }]);
    expect(shell("cat > out.ts <<'EOF'\nrg secret notes\ncat body.ts\nEOF\nwc -l < src/a.ts")).toEqual([
      { kind: "edit", path: "out.ts" },
      { kind: "read", path: "src/a.ts" },
    ]);
    expect(shell("rg -n needle src 2>&1 | head -n 5")).toEqual([{ kind: "search", path: "src", label: "needle" }]);
  });

  it("leaves out a grep that filters a pipe, and reads escaped quotes", () => {
    expect(shell('rg -l steps packages | grep -v "^.*test" | head -n 3')).toEqual([
      { kind: "search", path: "packages", label: "steps" },
    ]);
    expect(shell('grep -n "name: \\"\\|registerTool" src/mcp.ts')).toEqual([
      { kind: "search", path: "src/mcp.ts", label: 'name: "\\|registerTool' },
    ]);
  });

  it("keeps a word as a path only when it exists, given a way to tell", () => {
    const exists = (path: string) => path === "src/a.ts";
    expect(shellSteps({ root: ROOT, cwd: ROOT, exists }, "cat src/a.ts notes.md").map((step) => step.path)).toEqual([
      "src/a.ts",
    ]);
  });

  it("ignores commands that touch no file", () => {
    expect(shell("pnpm test && echo done")).toEqual([]);
  });
});

describe("the steps of other agents' tools", () => {
  it("reads Codex's shell, exec_command and apply_patch, from their working directory", () => {
    expect(
      steps(
        use("shell", { command: ["bash", "-lc", "sed -n '1,80p' trace.ts"], workdir: `${ROOT}/src` }),
        use("exec_command", { cmd: "rg needle" }),
        use("apply_patch", "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch"),
      ),
    ).toEqual([
      { kind: "read", path: "src/trace.ts", startLine: 1, endLine: 80 },
      { kind: "search", path: null, label: "needle" },
      { kind: "edit", path: "old.ts" },
    ]);
  });

  it("marks Grenier's cache lookups with what they found", () => {
    expect(
      steps(
        use(
          "mcp__grenier__ask_codebase",
          { question: "How does the proxy record usage?" },
          { error: false, text: '{\n  "status": "hit",\n  "answer": "…"\n}' },
        ),
        use("mcp__grenier__file_summary", { path: "src/proxy.ts" }, { error: false, text: '{"status":"miss"}' }),
        use("mcp__grenier__record_answer", { question: "q", answer: "a", files: ["src/a.ts"] }),
      ),
    ).toEqual([
      { kind: "ask", path: null, label: "How does the proxy record usage?", outcome: "hit" },
      { kind: "ask", path: "src/proxy.ts", outcome: "miss" },
    ]);
  });
});

describe("placing an edit", () => {
  const file = ["one", "two", "three", "four", "five", "six"].join("\n");
  const read = async (_root: string, path: string) => (path === "a.ts" ? file : null);
  const row = (callId: string, more: Partial<NewStep> = {}): NewStep => ({
    sessionId: "s1",
    callId,
    ts: 1,
    tool: "Edit",
    kind: "edit",
    path: "a.ts",
    ...more,
  });

  it("finds the lines of the new text, over all of a MultiEdit's edits, and leaves the rest alone", async () => {
    const rows = [
      row("e1"),
      row("e2"),
      row("e3"),
      row("e4", { startLine: 9, endLine: 9 }),
      row("e5", { path: "b.ts" }),
    ];
    await placeEdits(
      ROOT,
      rows,
      [
        use("Edit", { new_string: "three\nfour\n" }),
        use("MultiEdit", { edits: [{ new_string: "two" }, { new_string: "six" }] }),
        use("Edit", { new_string: "gone" }),
        use("Edit", { new_string: "one" }),
        use("Edit", { new_string: "one" }),
      ].map((call, at) => ({ ...call, id: `e${at + 1}` })),
      read,
    );
    expect(rows.map((entry) => [entry.startLine, entry.endLine])).toEqual([
      [3, 4],
      [2, 6],
      [undefined, undefined],
      [9, 9],
      [undefined, undefined],
    ]);
  });
});

describe("recording steps in the proxy", () => {
  let gateway: TestGateway;
  afterEach(async () => {
    await gateway.store.close();
  });

  const conversation = (calls: { id: string; input: unknown }[]) => ({
    model: "claude-opus-5-5",
    messages: [
      { role: "user", content: "look around" },
      ...calls.flatMap(({ id, input }) => [
        { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "1\tline" }] },
      ]),
    ],
  });

  it("keeps each call once, across the requests that resend it", async () => {
    gateway = testGateway(fakeUpstream(() => sse(fixture("stream-tool-use.sse"))));
    await gateway.store.sessions.create({ id: "s1", startedAt: gateway.clock.now, repoRoot: ROOT, cwd: ROOT });
    const first = { id: "t1", input: { file_path: `${ROOT}/a.ts` } };
    const second = { id: "t2", input: { file_path: `${ROOT}/b.ts`, offset: 3, limit: 2 } };

    await (await gateway.request("/s/s1/v1/messages", messagesRequest(conversation([first])))).text();
    await (await gateway.request("/s/s1/v1/messages", messagesRequest(conversation([first, second])))).text();

    await vi.waitFor(async () =>
      expect((await gateway.store.steps.list("s1")).map((step) => [step.path, step.startLine, step.endLine])).toEqual([
        ["a.ts", null, null],
        ["b.ts", 3, 4],
      ]),
    );
  });

  it("records nothing for a session with no repository", async () => {
    gateway = testGateway(fakeUpstream(() => sse(fixture("stream-tool-use.sse"))));
    const body = conversation([{ id: "t1", input: { file_path: "/somewhere/a.ts" } }]);
    await (await gateway.request("/s/loose/v1/messages", messagesRequest(body))).text();
    expect(await gateway.store.steps.list("loose")).toEqual([]);
  });
});
