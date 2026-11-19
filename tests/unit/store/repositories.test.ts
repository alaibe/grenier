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

  it("lists the paused sessions", async () => {
    await store.sessions.create(session("s1"));
    await store.sessions.create(session("s2"));
    await store.sessions.setPaused("s2", true);
    expect((await store.sessions.paused()).map((s) => s.id)).toEqual(["s2"]);
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

  it("sums spend by time and session", async () => {
    expect(await store.usage.spend({})).toBe(7.5);
    expect(await store.usage.spend({ since: 200 })).toBe(6);
    expect(await store.usage.spend({ sessionId: "s1" })).toBe(3.5);
    expect(await store.usage.spend({ sessionId: "none" })).toBe(0);
  });

  it("sums spend per session folder", async () => {
    await store.sessions.create({ id: "s3", startedAt: 1_000, cwd: "/home/notes", repoRoot: null, repoId: null });
    await store.usage.add({ sessionId: "s3", ts: 500, model: "m", cost: 0.5 });
    const folders = await store.usage.spendByFolder(200);
    expect(folders.sort((a, b) => b.spent - a.spent)).toEqual([
      { repoRoot: "/work/app", cwd: "/work/app", spent: 6 },
      { repoRoot: null, cwd: "/home/notes", spent: 0.5 },
      { repoRoot: null, cwd: null, spent: 0 },
    ]);
  });

  it("lists rows with their session's repository, oldest first", async () => {
    const rows = await store.usage.list({ since: 200 });
    expect(rows.map((row) => [row.sessionId, row.repoId, row.cwd])).toEqual([
      ["s1", "r1", "/work/app"],
      ["s2", "r2", "/work/app"],
      ["untagged", null, null],
    ]);
    expect((await store.usage.list({ sessionId: "s2" })).map((row) => row.ts)).toEqual([300]);
  });

  it("gives what a session's latest request cost", async () => {
    expect(await store.usage.lastCost("s1")).toBe(2);
    expect(await store.usage.lastCost("untagged")).toBeNull();
    expect(await store.usage.lastCost("none")).toBeNull();
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

describe("steps", () => {
  const step = (sessionId: string, callId: string, ts: number, path: string | null, part = 0) => ({
    sessionId,
    callId,
    part,
    ts,
    tool: "Read",
    kind: "read" as const,
    path,
  });

  it("keeps the first copy of a call's step and lists a session's steps in order", async () => {
    await store.steps.add([step("s1", "c2", 20, "b.ts"), step("s1", "c1", 10, "a.ts")]);
    await store.steps.add([{ ...step("s1", "c1", 30, "other.ts") }, step("s1", "c1", 30, "c.ts", 1)]);
    expect((await store.steps.list("s1")).map((row) => [row.callId, row.part, row.path])).toEqual([
      ["c1", 0, "a.ts"],
      ["c2", 0, "b.ts"],
      ["c1", 1, "c.ts"],
    ]);
    expect(await store.steps.list("s2")).toEqual([]);
  });

  it("sums up the sessions with steps, newest first", async () => {
    await store.steps.add([
      step("s1", "c1", 10, "a.ts"),
      step("s1", "c2", 20, "a.ts"),
      step("s1", "c3", 30, null),
      step("s2", "c1", 50, "b.ts"),
      step("s3", "c1", 1, "old.ts"),
    ]);
    expect(await store.steps.sessions(5)).toEqual([
      { sessionId: "s2", steps: 1, files: 1, first: 50, last: 50, asks: 0, hits: 0, readsBeforeAsk: 1 },
      { sessionId: "s1", steps: 3, files: 1, first: 10, last: 30, asks: 0, hits: 0, readsBeforeAsk: 3 },
    ]);
  });

  it("counts a session's questions to the cache, its hits, and the reads before its first question", async () => {
    const ask = (callId: string, ts: number, outcome: string) => ({
      ...step("s1", callId, ts, null),
      tool: "mcp__grenier__ask_codebase",
      kind: "ask" as const,
      outcome,
    });
    await store.steps.add([
      step("s1", "c1", 10, "a.ts"),
      step("s1", "c2", 20, "b.ts"),
      ask("c3", 30, "miss"),
      step("s1", "c4", 40, "c.ts"),
      ask("c5", 50, "hit"),
    ]);
    expect(await store.steps.sessions(0)).toMatchObject([{ sessionId: "s1", asks: 2, hits: 1, readsBeforeAsk: 2 }]);
  });

  it("prunes steps, usage and events older than a time", async () => {
    await store.steps.add([step("s1", "c1", 10, "a.ts"), step("s1", "c2", 30, "b.ts")]);
    await store.usage.add({ sessionId: "s1", ts: 10, cost: 1 });
    await store.usage.add({ sessionId: "s1", ts: 30, cost: 2 });
    await store.events.add({ sessionId: "s1", ts: 10, kind: "loop", detail: null });
    expect(await store.steps.prune(20)).toBe(1);
    expect(await store.usage.prune(20)).toBe(1);
    expect(await store.events.prune(20)).toBe(1);
    expect((await store.steps.list("s1")).map((row) => row.path)).toEqual(["b.ts"]);
    expect(await store.usage.spend({})).toBe(2);
    expect(await store.events.list()).toEqual([]);
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

describe("items", () => {
  it("finds a person by name whatever the case and accents, and a repeated question the same way", async () => {
    await store.sources.add({ id: "src", name: "mail", kind: "imap", config: {} });
    await store.items.put({
      id: "src:1",
      sourceId: "src",
      kind: "mail",
      title: "Lunch",
      body: "",
      people: ["Élodie Müller <elodie@example.org>"],
      ts: 1,
      contentHash: "h",
    });
    for (const name of ["élodie", "ELODIE", "muller", "Müller"]) {
      expect(
        (await store.items.withPerson(name, { sourceIds: ["src"] }, 10)).map((item) => item.id),
        name,
      ).toEqual(["src:1"]);
    }

    await store.answers.add(
      { id: "a1", repoId: "r", question: "Où est le café ?", answer: "old", createdAt: 1, author: "x" },
      [],
    );
    await store.answers.add(
      { id: "a2", repoId: "r", question: "OÙ EST LE CAFÉ ?", answer: "new", createdAt: 2, author: "x" },
      [],
    );
    expect(await store.answers.get("a1")).toBeUndefined();
  });
});
