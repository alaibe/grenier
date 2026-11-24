import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const { id, ...saved } = (await made.json()) as { id: string; waiting: boolean; team: boolean };
    expect(saved).toMatchObject({ waiting: true, team: false });
    expect(((await (await call("/overview")).json()) as { waiting: number }).waiting).toBe(0);
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
    team = { url: "https://team.test", token: "gt_x" };
    expect(((await (await call("/overview")).json()) as { waiting: number }).waiting).toBe(1);
  });

  it("lists the tree's pages without what other screens manage, and moves a folder with what it holds", async () => {
    const make = async (body: Record<string, unknown>) =>
      ((await (await call("/records", { method: "POST", body: JSON.stringify(body) })).json()) as { id: string }).id;
    const plan = await make({ title: "Plan", folder: "Ops" });
    const deep = await make({ title: "Runbook", folder: "Ops/Deploys" });
    await make({ title: "Elsewhere", folder: "Opsx" });
    await make({ type: "Task", title: "Bump hono", fields: { status: "to-do" } });
    expect(
      (await call("/records", { method: "POST", body: JSON.stringify({ title: "x", folder: "../up" }) })).status,
    ).toBe(400);
    const pages = async () =>
      ((await (await call("/pages")).json()) as { pages: { id: string; folder: string; title: string }[] }).pages;
    expect((await pages()).map((page) => [page.title, page.folder]).sort()).toEqual([
      ["Elsewhere", "Opsx"],
      ["Plan", "Ops"],
      ["Runbook", "Ops/Deploys"],
    ]);

    const move = (body: Record<string, unknown>) =>
      call("/folders/move", { method: "POST", body: JSON.stringify({ space: "team", ...body }) });
    expect((await move({ from: "Ops", to: "Ops/Inner" })).status).toBe(400);
    expect(await (await move({ from: "Ops", to: "Infra/Operations" })).json()).toEqual({ moved: 2 });
    expect((await store.records.get(plan))?.folder).toBe("Infra/Operations");
    expect((await store.records.get(deep))?.folder).toBe("Infra/Operations/Deploys");
    expect(await (await move({ from: "Infra", to: "Infra", toSpace: "me" })).json()).toEqual({ moved: 2 });
    expect((await store.records.get(deep))?.space).toBe("me");
    expect((await pages()).find((page) => page.title === "Elsewhere")?.folder).toBe("Opsx");
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
      }[];
    };
    expect(overview.version).toBe("test");
    expect(overview.days[0]?.requests).toBe(3);
    expect(overview.projects.map((row) => [row.key, row.cost])).toEqual([
      ["(not started with grenier run)", 0.75],
      ["app", 0.125],
    ]);
    expect(
      overview.sessions.map(({ key, client, project, startedAt }) => ({ key, client, project, startedAt })),
    ).toEqual([
      { key: "s2", client: "codex", project: null, startedAt: now },
      { key: "s1", client: "claude", project: "app", startedAt: now - 1000 },
      { key: "untagged", client: null, project: null, startedAt: now - 5000 },
    ]);
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
