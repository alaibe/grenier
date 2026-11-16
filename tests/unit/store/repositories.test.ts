import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: Store;

beforeEach(() => {
  store = openSqliteStore(":memory:");
});

afterEach(async () => {
  await store.close();
});

const session = (id: string, repoId: string | null = "r1") => ({
  id,
  client: "claude",
  cwd: "/work/app",
  repoRoot: repoId ? "/work/app" : null,
  repoId,
  startedAt: 1_000,
});

describe("sessions", () => {
  it("creates, reads, pauses and ends a session", async () => {
    await store.sessions.create(session("s1"));
    expect(await store.sessions.get("s1")).toMatchObject({ id: "s1", paused: false, endedAt: null });

    await store.sessions.setPaused("s1", true);
    expect((await store.sessions.get("s1"))?.paused).toBe(true);

    await store.sessions.end("s1", 2_000);
    expect((await store.sessions.get("s1"))?.endedAt).toBe(2_000);
  });

  it("leaves an existing session as it is when created again", async () => {
    await store.sessions.create(session("s1"));
    await store.sessions.create({ ...session("s1"), client: "other" });
    expect((await store.sessions.get("s1"))?.client).toBe("claude");
  });

  it("lists sessions started since a time", async () => {
    await store.sessions.create({ ...session("old"), startedAt: 1 });
    await store.sessions.create({ ...session("new"), startedAt: 5_000 });
    expect((await store.sessions.list({ since: 1_000 })).map((s) => s.id)).toEqual(["new"]);
  });

  it("is undefined for an unknown id", async () => {
    expect(await store.sessions.get("nope")).toBeUndefined();
  });
});

describe("usage", () => {
  beforeEach(async () => {
    await store.sessions.create(session("s1", "r1"));
    await store.sessions.create(session("s2", "r2"));
    await store.usage.add({ sessionId: "s1", ts: 100, model: "m", cost: 1.5 });
    await store.usage.add({ sessionId: "s1", ts: 200, model: "m", cost: 2 });
    await store.usage.add({ sessionId: "s2", ts: 300, model: "m", cost: 4 });
    await store.usage.add({ sessionId: "untagged", ts: 400, model: "m", cost: null });
  });

  it("sums spend by time, session and repository", async () => {
    expect(await store.usage.spend({})).toBe(7.5);
    expect(await store.usage.spend({ since: 200 })).toBe(6);
    expect(await store.usage.spend({ sessionId: "s1" })).toBe(3.5);
    expect(await store.usage.spend({ repoId: "r2" })).toBe(4);
    expect(await store.usage.spend({ sessionId: "none" })).toBe(0);
  });

  it("lists rows with their session's repository, oldest first", async () => {
    const rows = await store.usage.list({ since: 200 });
    expect(rows.map((row) => [row.sessionId, row.repoId])).toEqual([
      ["s1", "r1"],
      ["s2", "r2"],
      ["untagged", null],
    ]);
    expect((await store.usage.list({ sessionId: "s2" })).map((row) => row.ts)).toEqual([300]);
  });
});

describe("events", () => {
  it("lists events by session, kind and time", async () => {
    await store.events.add({ sessionId: "s1", ts: 1, kind: "loop", detail: "{}" });
    await store.events.add({ sessionId: "s1", ts: 2, kind: "budget", detail: null });
    await store.events.add({ sessionId: "s2", ts: 3, kind: "loop", detail: null });
    expect((await store.events.list({ sessionId: "s1" })).map((e) => e.kind)).toEqual(["loop", "budget"]);
    expect((await store.events.list({ kind: "loop" })).map((e) => e.sessionId)).toEqual(["s1", "s2"]);
    expect((await store.events.list({ since: 2 })).length).toBe(2);
  });
});

describe("budgets", () => {
  it("sets, replaces and removes limits", async () => {
    await store.budgets.set("daily", "", 10);
    await store.budgets.set("repo", "app", 2);
    await store.budgets.set("daily", "", 12);
    expect(await store.budgets.list()).toEqual([
      { scope: "daily", key: "", period: "day", limitAmount: 12 },
      { scope: "repo", key: "app", period: "day", limitAmount: 2 },
    ]);
    await store.budgets.remove("repo", "app");
    expect((await store.budgets.list()).map((b) => b.scope)).toEqual(["daily"]);
  });
});
