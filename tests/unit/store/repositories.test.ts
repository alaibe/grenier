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

  it("lists rows with their session's repository, oldest first", async () => {
    const rows = await store.usage.list({ since: 200 });
    expect(rows.map((row) => [row.sessionId, row.repoId, row.cwd])).toEqual([
      ["s1", "r1", "/work/app"],
      ["s2", "r2", "/work/app"],
      ["untagged", null, null],
    ]);
    expect((await store.usage.list({ sessionId: "s2" })).map((row) => row.ts)).toEqual([300]);
  });
});

describe("pruning", () => {
  it("prunes usage and events older than a time", async () => {
    await store.usage.add({ sessionId: "s1", ts: 10, cost: 1 });
    await store.usage.add({ sessionId: "s1", ts: 30, cost: 2 });
    await store.events.add({ sessionId: "s1", ts: 10, kind: "loop", detail: null });
    expect(await store.usage.prune(20)).toBe(1);
    expect(await store.events.prune(20)).toBe(1);
    expect((await store.usage.list()).map((row) => row.cost)).toEqual([2]);
    expect(await store.events.list()).toEqual([]);
  });
});

describe("records", () => {
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    top: "team",
    type: "Doc",
    title: "Deploys on Friday",
    folder: "",
    body: "Only before noon.",
    fields: {},
    author: "ada",
    device: "ada-mbp",
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    retiredAt: null,
    version: 0,
    anchors: [{ kind: "git" as const, repoId: "r", ref: "src/a.ts", version: "abc" }],
    links: [{ kind: "record" as const, ref: "p1" }],
    ...extra,
  });

  it("keeps a record with its anchors and links, and replaces them with it", async () => {
    await store.records.put(record("r1"));
    expect(await store.records.get("r1")).toMatchObject({
      title: "Deploys on Friday",
      anchors: [{ ref: "src/a.ts" }],
      links: [{ ref: "p1" }],
    });
    await store.records.put(record("r1", { anchors: [], links: [], title: "Deploys on Fridays" }));
    expect(await store.records.get("r1")).toMatchObject({ title: "Deploys on Fridays", anchors: [], links: [] });
  });

  it("lists by top, type and link, newest first, without the retired ones unless asked", async () => {
    await store.records.put(record("r1", { updatedAt: 1 }));
    await store.records.put(record("r2", { updatedAt: 2, type: "Task", kind: null, links: [] }));
    await store.records.put(record("r3", { updatedAt: 3, retiredAt: 3 }));
    expect((await store.records.list({ tops: ["team"] })).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect((await store.records.list({ tops: ["team"], retired: true })).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect((await store.records.list({ tops: ["team"], type: "Task" })).map((r) => r.id)).toEqual(["r2"]);
    expect(
      (await store.records.list({ tops: ["team"], linkedTo: { kind: "record", ref: "p1" } })).map((r) => r.id),
    ).toEqual(["r1"]);
    expect(await store.records.list({ tops: [] })).toEqual([]);
  });

  it("searches titles and bodies with the stemmer, in the tops given", async () => {
    await store.records.put(record("r1", { title: "How does streaming work?" }));
    await store.records.put(record("r2", { top: "me", title: "Streamed responses" }));
    expect((await store.records.search(["streams"], ["team"], 10)).map((r) => r.id)).toEqual(["r1"]);
    expect((await store.records.search(["streams"], ["team", "me"], 10)).map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("keeps a vector until the text changes, and counts reuses", async () => {
    await store.records.put(record("r1"), { model: "m", vector: Float32Array.from([1, 0]) });
    await store.records.put(record("r1", { fields: { extra: 1 } }));
    expect(await store.records.vectors(["team"], "m")).toHaveLength(1);
    await store.records.put(record("r1", { body: "Changed." }));
    expect(await store.records.vectors(["team"], "m")).toEqual([]);
    await store.records.hit("r1");
    expect((await store.records.get("r1"))?.hits).toBe(1);
    expect(await store.records.stats()).toEqual([{ top: "team", type: "Doc", records: 1, hits: 1 }]);
  });
});

describe("tops, the outbox, history and approvals", () => {
  it("gives pending changes oldest first, and leaves `me` ones out when asked", async () => {
    await store.outbox.add({ id: "c1", recordId: "r1", change: {}, baseVersion: 0, createdAt: 1 });
    await store.outbox.add({ id: "c2", recordId: "r2", change: {}, baseVersion: 0, createdAt: 2 });
    const mine = { recordId: "r3", change: { record: { top: "me" } }, baseVersion: 0, createdAt: 3 };
    await store.outbox.add({ id: "c3", ...mine });
    expect((await store.outbox.pending(10)).map((entry) => entry.id)).toEqual(["c1", "c2", "c3"]);
    expect((await store.outbox.pending(10, true)).map((entry) => entry.id)).toEqual(["c1", "c2"]);
    await store.outbox.remove(["c2", "c3"]);
    expect((await store.outbox.list()).map((entry) => entry.id)).toEqual(["c1"]);
  });

  it("keeps each version once, and approvals by record and kind", async () => {
    const entry = { recordId: "r1", version: 1, author: "ada", device: null, ts: 1, snapshot: { title: "t" } };
    await store.history.add(entry);
    await store.history.add({ ...entry, snapshot: { title: "other" } });
    expect(await store.history.list("r1")).toMatchObject([{ version: 1, snapshot: { title: "t" } }]);
    const approval = {
      recordId: "s1",
      kind: "skill" as const,
      hash: "h",
      approvedAt: 1,
      settings: {},
      previousHash: null,
    };
    await store.approvals.put(approval);
    await store.approvals.put({ ...approval, hash: "h2" });
    expect(await store.approvals.list("skill")).toMatchObject([{ hash: "h2" }]);
  });
});
