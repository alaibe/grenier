import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoText } from "@grenier/connectors/git";
import { defaultConfig } from "@grenier/core";
import { createGateway } from "@grenier/gateway";
import type { TeamClient } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeDeps } from "../../support/repo.ts";

const TOKEN = "ga_admin-test";
let store: Store;
let dir: string;
let app: ReturnType<typeof createGateway>;
let team: TeamClient | null;
let synced: number;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  await store.spaces.put({ id: "me", name: "me", kind: "me", repoId: null, root: null });
  await store.spaces.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
  dir = mkdtempSync(join(tmpdir(), "grenier-admin-"));
  team = null;
  synced = 0;
  const config = defaultConfig();
  app = createGateway({
    store,
    config,
    prices: loadPrices(),
    port: 7788,
    admin: {
      token: TOKEN,
      version: "test",
      readFile: repoText,
      host: {
        storeDeps: () => storeDeps(store),
        team: () => team,
        syncNow: async () => {
          synced += 1;
        },
      },
    },
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
    const refused = await app.request("http://127.0.0.1:7788/admin/overview", {
      headers: { origin: "tauri://localhost", authorization: "Bearer wrong" },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(
      (await call("/overview", { origin: "https://evil.example" })).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it("creates, lists and revokes clients, with known scopes only", async () => {
    const created = await call("/clients", {
      method: "POST",
      body: JSON.stringify({ name: "claude", scopes: ["team"] }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { token: string }).token).toMatch(/^gc_/);
    expect(
      (await call("/clients", { method: "POST", body: JSON.stringify({ name: "x", scopes: ["nowhere"] }) })).status,
    ).toBe(400);
    expect(
      ((await (await call("/clients")).json()) as { clients: { name: string }[] }).clients.map((c) => c.name),
    ).toEqual(["claude"]);
    expect((await call("/clients/claude/revoke", { method: "POST" })).status).toBe(200);
    expect(((await (await call("/clients")).json()) as { clients: unknown[] }).clients).toEqual([]);
  });

  it("shows the audit log", async () => {
    await store.audit.add({ ts: Date.now(), clientId: "c1", tool: "recall", args: { query: "x" }, recordIds: ["a"] });
    expect(
      ((await (await call("/audit")).json()) as { entries: { tool: string }[] }).entries.map((e) => e.tool),
    ).toEqual(["recall"]);
  });

  it("writes, lists, searches, edits and retires records for the editor", async () => {
    const made = await call("/records", {
      method: "POST",
      body: JSON.stringify({
        type: "Decision",
        title: "Use SQLite",
        fields: { owner: "ada", date: "2026-11-20", reason: "One file." },
      }),
    });
    expect(made.status).toBe(201);
    const { id, waiting } = (await made.json()) as { id: string; waiting: boolean };
    expect(waiting).toBe(true);
    const refused = await call("/records", {
      method: "POST",
      body: JSON.stringify({ type: "Decision", title: "No date" }),
    });
    expect(refused.status).toBe(400);

    const listed = (await (await call("/records?type=Decision")).json()) as { records: { id: string }[] };
    expect(listed.records.map((record) => record.id)).toEqual([id]);
    const found = (await (await call("/records?q=sqlite")).json()) as { records: { id: string }[] };
    expect(found.records.map((record) => record.id)).toEqual([id]);

    const edited = await call(`/records/${id}`, { method: "PUT", body: JSON.stringify({ body: "Because one file." }) });
    expect(edited.status).toBe(200);
    const shown = (await (await call(`/records/${id}`)).json()) as {
      body: string;
      status: string;
      linkedFrom: unknown[];
    };
    expect(shown).toMatchObject({ body: "Because one file.", status: "hit", linkedFrom: [] });
    expect((await call(`/records/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(((await (await call("/records?type=Decision")).json()) as { records: unknown[] }).records).toEqual([]);
    expect((await store.outbox.list()).length).toBe(3);
  });

  it("shows what links to a record and its type list", async () => {
    const project = (await (
      await call("/records", { method: "POST", body: JSON.stringify({ type: "Project", title: "Checkout" }) })
    ).json()) as { id: string };
    await call("/records", {
      method: "POST",
      body: JSON.stringify({ type: "Doc", title: "Checkout spec", links: [{ kind: "record", ref: project.id }] }),
    });
    const shown = (await (await call(`/records/${project.id}`)).json()) as { linkedFrom: { title: string }[] };
    expect(shown.linkedFrom.map((entry) => entry.title)).toEqual(["Checkout spec"]);
    const types = (await (await call("/types")).json()) as { types: { name: string }[] };
    expect(types.types.map((type) => type.name)).toContain("Meeting");
  });

  it("saves straight to the team store, and hands back a teammate's version when they changed the same field", async () => {
    const sent: unknown[] = [];
    let conflict = false;
    team = {
      url: "https://team.test",
      token: "gt_x",
      fetch: (async (_url: unknown, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return Response.json(
          conflict
            ? { applied: [], refused: [], conflicts: [{ current: { body: "Theirs." } }] }
            : { applied: [{ version: 7 }], refused: [], conflicts: [] },
        );
      }) as unknown as typeof fetch,
    };
    const made = (await (
      await call("/records", { method: "POST", body: JSON.stringify({ type: "Doc", title: "Runbook" }) })
    ).json()) as { id: string };
    expect((await store.records.get(made.id))?.version).toBe(7);
    expect(synced).toBe(1);
    conflict = true;
    const clash = await call(`/records/${made.id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "Mine.", baseVersion: 7 }),
    });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ conflict: { body: "Theirs." } });
    expect((sent[1] as { changes: { check: boolean; changed: string[] }[] }).changes[0]).toMatchObject({
      check: true,
      changed: ["body"],
    });
  });

  it("passes the team's pages through with this device's token, and says when there is no team", async () => {
    expect((await call("/team/members")).status).toBe(409);
    team = {
      url: "https://team.test",
      token: "gt_x",
      fetch: (async (url: URL) => Response.json({ path: url.pathname })) as unknown as typeof fetch,
    };
    expect(await (await call("/team/members")).json()).toEqual({ path: "/api/members" });
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
    const ask = { tool: "mcp__grenier__recall", kind: "ask" as const, ts: now, sessionId: "s1" };
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
    expect((overview.sessions as { key: string; traced?: boolean }[]).map(({ key, traced }) => [key, traced])).toEqual([
      ["s2", false],
      ["s1", true],
      ["untagged", false],
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
