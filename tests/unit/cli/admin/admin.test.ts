import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamClient } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestAdmin, testAdmin } from "../../../support/gateway.ts";

let store: Store;
let dir: string;
let admin: TestAdmin;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  await store.tops.put({ id: "me", name: "me", kind: "me", repoId: null, root: null });
  await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
  dir = mkdtempSync(join(tmpdir(), "grenier-admin-"));
  admin = testAdmin(store, dir);
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init?: RequestInit & { origin?: string }) => admin.call(path, init);

describe("the admin API", () => {
  it("needs the admin token", async () => {
    expect((await admin.raw("http://127.0.0.1:7788/admin/overview")).status).toBe(401);
    expect((await admin.raw("http://127.0.0.1:7788/admin/key", { method: "POST" })).status).toBe(401);
    expect((await call("/overview", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("/overview")).status).toBe(200);
  });

  it("answers the desktop app's origin with CORS, and no other", async () => {
    const preflight = await admin.raw("http://127.0.0.1:7788/admin/overview", {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect((await call("/overview", { origin: "tauri://localhost" })).headers.get("access-control-allow-origin")).toBe(
      "tauri://localhost",
    );
    const evil = await admin.raw("http://127.0.0.1:7788/admin/overview", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    const refused = await admin.raw("http://127.0.0.1:7788/admin/overview", {
      headers: { origin: "tauri://localhost", authorization: "Bearer wrong" },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(
      (await call("/overview", { origin: "https://evil.example" })).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it("answers a path it does not serve itself, and never passes it on to the model provider", async () => {
    const unknown = await call("/nowhere", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "no POST /nowhere" });
    expect(admin.upstream.requests).toEqual([]);
  });

  it("answers a refusal from any resource as a 4xx, and a bug as a 500, not as a refusal", async () => {
    const team: TeamClient = { url: "https://team.test", token: "gt_x" };
    admin = testAdmin(store, dir, { team: () => team });
    const long = await call("/routines", {
      method: "POST",
      body: JSON.stringify({ title: "Long", prompt: "x".repeat(20_001) }),
    });
    expect(long.status).toBe(409);
    expect(((await long.json()) as { error: string }).error).toContain("the record is refused");
    const { id } = (await (
      await call("/routines", { method: "POST", body: JSON.stringify({ title: "Tidy", prompt: "Tidy up." }) })
    ).json()) as { id: string };
    const wrong = await call(`/routines/${id}/approve`, { method: "POST", body: JSON.stringify({ mode: "anything" }) });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { error: string }).error).toContain("a mode is one of");

    admin = testAdmin(store, dir, {
      storeDeps: async () => {
        throw new TypeError("a bug");
      },
    });
    const bug = await call("/overview");
    expect(bug.status).toBe(500);
    expect(await bug.text()).not.toContain("a bug");
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
