import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoText } from "@grenier/connectors/git";
import { defaultConfig } from "@grenier/core";
import { createGateway } from "@grenier/gateway";
import type { RepoFiles } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TOKEN = "ga_admin-test";
let store: Store;
let dir: string;
let app: ReturnType<typeof createGateway>;
/** Current blob hashes, as the stand-in for git: a path left out is a deleted file. */
let blobs: Record<string, string>;
const files: Pick<RepoFiles, "hashes"> = {
  hashes: async (_root, paths) => new Map(paths.map((path) => [path, blobs[path] ?? null])),
};

beforeEach(() => {
  store = openSqliteStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "grenier-admin-"));
  writeFileSync(join(dir, "plans.md"), "# Plans\n\nShip the desktop app.\n");
  blobs = {};
  const config = defaultConfig();
  config.budgets.session = 4;
  app = createGateway({
    store,
    config,
    prices: loadPrices(),
    port: 7788,
    admin: { token: TOKEN, version: "test", readFile: repoText, files },
  });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(path: string, init: RequestInit & { origin?: string } = {}) {
  const { origin, ...rest } = init;
  return app.request(`http://127.0.0.1:7788/admin${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

describe("the admin API", () => {
  it("needs the admin token", async () => {
    expect((await app.request("http://127.0.0.1:7788/admin/overview")).status).toBe(401);
    expect((await call("/overview", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("/overview")).status).toBe(200);
  });

  it("answers the desktop app's origin with CORS, and no other", async () => {
    const preflight = await app.request("http://127.0.0.1:7788/admin/overview", {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect((await call("/overview", { origin: "tauri://localhost" })).headers.get("access-control-allow-origin")).toBe(
      "tauri://localhost",
    );
    const evil = await app.request("http://127.0.0.1:7788/admin/overview", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(
      (await call("/overview", { origin: "https://evil.example" })).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it("adds a source, syncs it, and lists it without anything secret", async () => {
    const added = await call("/sources", {
      method: "POST",
      body: JSON.stringify({ kind: "markdown", name: "journal", path: dir }),
    });
    expect(added.status).toBe(201);
    expect(((await added.json()) as { sync: { added: number } }).sync.added).toBe(1);

    await call("/sources", {
      method: "POST",
      body: JSON.stringify({
        kind: "imap",
        name: "mail",
        host: "imap.example.org",
        user: "ada",
        password_command: "false",
      }),
    });
    const refusedName = await call("/sources", {
      method: "POST",
      body: JSON.stringify({
        kind: "imap",
        name: "work",
        host: "imap.example.org",
        user: "ada",
        password_command: "false",
      }),
    });
    expect(refusedName.status).toBe(201);

    const listed = (await (await call("/sources")).json()) as {
      sources: { name: string; items: number; config: object }[];
    };
    expect(listed.sources.find((source) => source.name === "journal")?.items).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("password");
    expect((await call("/sources/journal", { method: "DELETE" })).status).toBe(200);
  });

  it("refuses a source named after a kind, or without what its kind needs", async () => {
    expect(
      (await call("/sources", { method: "POST", body: JSON.stringify({ kind: "markdown", name: "notes", path: dir }) }))
        .status,
    ).toBe(400);
    const missing = await call("/sources", {
      method: "POST",
      body: JSON.stringify({ kind: "caldav", name: "cal", url: "https://x" }),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("username");
  });

  it("creates, lists and revokes clients, with known scopes only", async () => {
    const created = await call("/clients", {
      method: "POST",
      body: JSON.stringify({ name: "claude", scopes: ["notes"] }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { token: string }).token).toMatch(/^gc_/);
    expect(
      (await call("/clients", { method: "POST", body: JSON.stringify({ name: "x", scopes: ["secrets"] }) })).status,
    ).toBe(400);
    expect(
      ((await (await call("/clients")).json()) as { clients: { name: string }[] }).clients.map((c) => c.name),
    ).toEqual(["claude"]);
    expect((await call("/clients/claude/revoke", { method: "POST" })).status).toBe(200);
    expect(((await (await call("/clients")).json()) as { clients: unknown[] }).clients).toEqual([]);
  });

  it("shows the audit log and decides on the review queue", async () => {
    await store.audit.add({ ts: Date.now(), clientId: "c1", tool: "search", args: { query: "x" }, itemIds: ["a"] });
    expect(
      ((await (await call("/audit")).json()) as { entries: { tool: string }[] }).entries.map((e) => e.tool),
    ).toEqual(["search"]);

    await store.review.add({ id: "r1", clientId: "c1", text: "Remember this.", tags: [], ts: 1 });
    await store.review.add({ id: "r2", clientId: "c1", text: "Not this.", tags: [], ts: 2 });
    expect(((await (await call("/review")).json()) as { pending: unknown[] }).pending).toHaveLength(2);
    expect((await call("/review/r1/approve", { method: "POST" })).status).toBe(200);
    expect((await call("/review/r2/reject", { method: "POST" })).status).toBe(200);
    expect((await call("/review/r2/reject", { method: "POST" })).status).toBe(404);
    expect((await store.items.get("memory:r1"))?.body).toBe("Remember this.");
  });

  it("gives the overview, per day, project and session, and the reports", async () => {
    const now = Date.now();
    await store.sessions.create({
      id: "s1",
      client: "claude",
      startedAt: now - 1000,
      repoRoot: "/work/app",
      repoId: "r1",
    });
    await store.sessions.create({ id: "s2", client: "codex", startedAt: now });
    await store.sessions.create({ id: "untagged", startedAt: now - 5000 });
    const ask = { tool: "mcp__grenier__ask_codebase", kind: "ask" as const, ts: now, sessionId: "s1" };
    await store.steps.add([
      { ...ask, callId: "c1", outcome: "hit" },
      { ...ask, callId: "c2", outcome: "miss" },
    ]);
    for (const [sessionId, cost] of [
      ["s1", 0.125],
      ["s2", 0.5],
      ["untagged", 0.25],
    ] as const) {
      await store.usage.add({ sessionId, ts: now, model: "claude-opus-5-5", inputTokens: 10, cost });
    }

    const overview = (await (await call("/overview")).json()) as {
      version: string;
      days: { requests: number }[];
      projects: { key: string; cost: number }[];
      sessions: {
        key: string;
        client: string | null;
        project: string | null;
        startedAt: number | null;
        asks: number | null;
        hits: number | null;
      }[];
    };
    expect(overview.version).toBe("test");
    expect(overview.days[0]?.requests).toBe(3);
    expect(overview.projects.map((row) => [row.key, row.cost])).toEqual([
      ["(not started with grenier run)", 0.75],
      ["app", 0.125],
    ]);
    expect(
      overview.sessions.map(({ key, client, project, startedAt, asks, hits }) => ({
        key,
        client,
        project,
        startedAt,
        asks,
        hits,
      })),
    ).toEqual([
      { key: "s2", client: "codex", project: null, startedAt: now, asks: null, hits: null },
      { key: "s1", client: "claude", project: "app", startedAt: now - 1000, asks: 2, hits: 1 },
      { key: "untagged", client: null, project: null, startedAt: now - 5000, asks: null, hits: null },
    ]);
    expect((await call("/report?by=week")).status).toBe(400);
    expect((await call("/report?since=forever")).status).toBe(400);
  });

  it("lists traces, gives one with its requests' cost, and shows only the files it touched", async () => {
    const repo = realpathSync(mkdtempSync(join(dir, "repo-")));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src/untouched.ts"), "export const b = 2;\n");
    writeFileSync(join(dir, "outside.txt"), "not in the repository\n");
    symlinkSync(join(dir, "outside.txt"), join(repo, "link.txt"));
    const now = Date.now();
    await store.sessions.create({ id: "s1", client: "claude", repoRoot: repo, cwd: repo, startedAt: now - 1000 });
    await store.sessions.create({ id: "loose", startedAt: now });
    const step = { sessionId: "s1", tool: "Read", kind: "read" as const, ts: now };
    await store.steps.add([
      { ...step, callId: "c1", path: "src/a.ts", startLine: 1, endLine: 1 },
      { ...step, callId: "c2", path: "link.txt" },
      { ...step, callId: "c3", tool: "Grep", kind: "search", path: null, label: "needle" },
    ]);
    await store.steps.add([{ ...step, sessionId: "loose", callId: "c1", path: "x.ts" }]);
    await store.usage.add({ sessionId: "s1", ts: now, model: "claude-opus-5-5", cost: 0.25 });

    const list = (await (await call("/traces")).json()) as { traces: { id: string; steps: number; files: number }[] };
    expect(list.traces).toEqual([
      expect.objectContaining({
        id: "s1",
        client: "claude",
        repo: repo.split("/").at(-1),
        steps: 3,
        files: 2,
        asks: 0,
        hits: 0,
        readsBeforeAsk: 2,
      }),
    ]);

    const trace = (await (await call("/traces/s1")).json()) as {
      steps: Record<string, unknown>[];
      requests: { cost: number }[];
    };
    expect(trace.steps.map((entry) => entry.path)).toEqual(["src/a.ts", "link.txt", null]);
    expect(trace.steps[0]).not.toHaveProperty("sessionId");
    expect(trace.requests).toEqual([{ ts: now, cost: 0.25 }]);
    expect((await call("/traces/loose")).status).toBe(404);
    expect((await call("/traces/nobody")).status).toBe(404);

    const file = (await (await call("/traces/s1/file?path=src/a.ts")).json()) as { text: string };
    expect(file.text).toBe("export const a = 1;\n");
    for (const path of ["src/untouched.ts", "link.txt", "../outside.txt", "", "src"]) {
      expect((await call(`/traces/s1/file?path=${encodeURIComponent(path)}`)).status).toBe(404);
    }
  });

  it("lists the cache by repository, its answers with what changed, and forgets one", async () => {
    await store.sessions.create({ id: "s1", repoRoot: "/work/app", repoId: "r1", startedAt: 1 });
    const add = (id: string, question: string, blob: string) =>
      store.answers.add({ id, repoId: "r1", question, answer: `About ${question}`, createdAt: 5, author: "local" }, [
        { path: "src/a.ts", blobHash: blob },
      ]);
    await add("a1", "Where is routing?", "aaa");
    await add("a2", "How are budgets checked?", "old");
    await store.answers.refuse("a2", "the team server answered: too long");
    await store.answers.add(
      { id: "x1", repoId: "elsewhere-id-123456", question: "q", answer: "a", createdAt: 1, author: "ada" },
      [],
    );
    blobs = { "src/a.ts": "aaa" };

    const repos = (await (await call("/cache")).json()) as { repos: Record<string, unknown>[] };
    expect(repos.repos).toEqual([
      { id: "r1", name: "app", answers: 2, hits: 0, summaries: 0, shared: false },
      { id: "elsewhere-id-123456", name: "elsewhere-id", answers: 1, hits: 0, summaries: 0, shared: false },
    ]);

    const listed = (await (await call("/cache/r1")).json()) as { answers: Record<string, unknown>[] };
    expect(listed.answers.map((answer) => [answer.id, answer.changed, answer.shareError])).toEqual([
      ["a1", [], null],
      ["a2", ["src/a.ts"], "the team server answered: too long"],
    ]);
    const unknown = (await (await call("/cache/elsewhere-id-123456")).json()) as { answers: { changed: unknown }[] };
    expect(unknown.answers[0]?.changed).toBeNull();

    expect((await call("/cache/answers/a1", { method: "DELETE" })).status).toBe(200);
    expect(await store.answers.get("a1")).toBeUndefined();
    expect((await call("/cache/answers/a1", { method: "DELETE" })).status).toBe(404);
  });

  it("shows the limits, from the config until one is set, and sets and removes them", async () => {
    await store.sessions.create({ id: "s1", repoRoot: "/work/app", repoId: "r1", startedAt: 1 });
    await store.sessions.create({ id: "s2", cwd: "/home/notes", startedAt: 2 });
    await store.usage.add({ sessionId: "s1", ts: Date.now(), cost: 1.5 });
    const budgets = async () => (await (await call("/budgets")).json()) as Record<string, unknown>;
    expect(await budgets()).toEqual({
      daily: null,
      session: 4,
      fromConfig: { daily: false, session: true },
      repos: [],
      known: ["app", "notes"],
      spentToday: 1.5,
    });

    const set = (body: unknown) => call("/budgets", { method: "POST", body: JSON.stringify(body) });
    expect((await set({ scope: "daily", limit: 10 })).status).toBe(200);
    expect((await set({ scope: "session", limit: 2 })).status).toBe(200);
    expect((await set({ scope: "repo", key: "app", limit: 1 })).status).toBe(200);
    expect(await budgets()).toMatchObject({
      daily: 10,
      session: 2,
      fromConfig: { daily: false, session: false },
      repos: [{ name: "app", limit: 1 }],
    });

    expect((await set({ scope: "session", limit: null })).status).toBe(200);
    expect((await budgets()).session).toBe(4);
    expect((await set({ scope: "weekly", limit: 1 })).status).toBe(400);
    expect((await set({ scope: "daily", limit: -1 })).status).toBe(400);
    expect((await set({ scope: "repo", limit: 1 })).status).toBe(400);
  });

  it("lists the paused sessions and resumes one", async () => {
    await store.sessions.create({ id: "s1", client: "claude", repoRoot: "/work/app", startedAt: 1 });
    await store.sessions.setPaused("s1", true);
    await store.events.add({ sessionId: "s1", ts: 42, kind: "pause", detail: null });

    expect(await (await call("/sessions/paused")).json()).toEqual({
      sessions: [{ id: "s1", client: "claude", repo: "app", pausedAt: 42 }],
    });
    expect(((await (await call("/overview")).json()) as { paused: number }).paused).toBe(1);

    expect(await (await call("/sessions/s1/resume", { method: "POST" })).json()).toEqual({ resumed: "s1" });
    expect((await store.sessions.get("s1"))?.paused).toBe(false);
    expect((await store.events.list({ kind: "resume" })).map((event) => event.sessionId)).toEqual(["s1"]);
    expect((await call("/sessions/nobody/resume", { method: "POST" })).status).toBe(404);
  });
});
