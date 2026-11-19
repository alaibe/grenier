import { forgetAnswer, syncOnce, type TeamClient } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hash, startWorker } from "../../support/worker.ts";

let mf: Miniflare;
let machineA: Store;
let machineB: Store;
let teamA: TeamClient;
let teamB: TeamClient;

beforeAll(async () => {
  ({ mf } = await startWorker());
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO members (id, name, token_hash, role, created_at) VALUES ('a', 'ada', ?, 'admin', 0), ('b', 'bob', ?, 'member', 0)",
    )
    .bind(hash("gt_ada"), hash("gt_bob"))
    .run();
  const fetchFromWorker = ((input: URL | string, init?: RequestInit) =>
    mf.dispatchFetch(String(input), init as never)) as unknown as typeof fetch;
  teamA = { url: "https://team.test", token: "gt_ada", fetch: fetchFromWorker };
  teamB = { url: "https://team.test", token: "gt_bob", fetch: fetchFromWorker };
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  machineA = openSqliteStore(":memory:");
  machineB = openSqliteStore(":memory:");
  await machineA.team.share("repo-1", "/work/app", 0);
  await machineB.team.share("repo-1", "/home/bob/app", 0);
});

const devices = new WeakMap<Store, string>();
const sync = (store: Store, team: TeamClient, shareAll = false) => {
  const device = devices.get(store) ?? `device-${Math.random().toString(36).slice(2)}`;
  devices.set(store, device);
  return syncOnce({
    store,
    embedder: null,
    team,
    savedOf: (row) => (row.cacheReadTokens ?? 0) / 1_000_000,
    shareAll,
    device,
  });
};
async function spentBy(team: TeamClient): Promise<number> {
  const response = await mf.dispatchFetch("https://team.test/api/budget", {
    headers: { authorization: `Bearer ${team.token}` },
  });
  return ((await response.json()) as { member: { spent: number } }).member.spent;
}

async function record(store: Store, id: string, question: string, repoId = "repo-1", answer = `Answer to ${question}`) {
  await store.answers.add({ id, repoId, question, answer, createdAt: Date.now(), author: "local" }, [
    { path: "src/a.ts", blobHash: "1".repeat(40) },
  ]);
}

describe("team sync", () => {
  it("brings an answer recorded on machine A to machine B, with its sources and its author", async () => {
    const id = `q-${Date.now()}`;
    await record(machineA, id, `Where is the router? ${id}`);

    expect((await sync(machineA, teamA)).pushed.answers).toBe(1);
    expect((await sync(machineB, teamB)).pulled.answers).toBeGreaterThanOrEqual(1);

    expect(await machineB.answers.get(id)).toMatchObject({
      author: "ada",
      shared: true,
      sources: [{ path: "src/a.ts", blobHash: "1".repeat(40) }],
    });
    expect((await sync(machineA, teamA)).pushed.answers).toBe(0);
  });

  it("keeps a repository that is not shared on the machine", async () => {
    const id = `private-${Date.now()}`;
    await record(machineA, id, "Secret question", "repo-private");
    await sync(machineA, teamA);
    expect((await machineA.answers.get(id))?.shared).toBe(false);
  });

  it("shares every repository's answers when share_with_team is on", async () => {
    const id = `all-${Date.now()}`;
    await record(machineA, id, "Question in another repo", "repo-other");
    expect((await sync(machineA, teamA, true)).pushed.answers).toBe(1);
  });

  it("removes on B an answer that A replaced", async () => {
    const first = `old-${Date.now()}`;
    const question = `How are tokens hashed? ${first}`;
    await record(machineA, first, question);
    await sync(machineA, teamA);
    await sync(machineB, teamB);
    expect(await machineB.answers.get(first)).toBeDefined();

    const second = `new-${Date.now()}`;
    await record(machineA, second, question);
    await sync(machineA, teamA);
    const result = await sync(machineB, teamB);

    expect(result.pulled.removed).toBeGreaterThanOrEqual(1);
    expect(await machineB.answers.get(first)).toBeUndefined();
    expect(await machineB.answers.get(second)).toBeDefined();
  });

  it("shares summaries", async () => {
    await machineA.summaries.put({
      repoId: "repo-1",
      path: "src",
      blobHash: "tree:x",
      summary: "The sources.",
      createdAt: 1,
    });
    await sync(machineA, teamA);
    await sync(machineB, teamB);
    expect(await machineB.summaries.get("repo-1", "src", "tree:x")).toMatchObject({
      summary: "The sources.",
      shared: true,
    });
  });

  it("pushes usage as daily numbers, once, and the team budget counts it", async () => {
    await machineA.usage.add({
      sessionId: "s",
      ts: Date.now(),
      model: "m",
      inputTokens: 10,
      cacheReadTokens: 2_000_000,
      cost: 0.4,
    });
    await machineA.usage.add({ sessionId: "s", ts: Date.now(), model: "m", inputTokens: 5, cost: 0.1 });
    expect((await sync(machineA, teamA)).pushed.usageRows).toBe(2);
    expect((await sync(machineA, teamA)).pushed.usageRows).toBe(0);

    const budget = await (
      await teamA.fetch?.("https://team.test/api/budget", { headers: { authorization: "Bearer gt_ada" } })
    )?.json();
    expect((budget as { member: { spent: number } }).member.spent).toBeCloseTo(0.5, 10);
  });

  it("brings a repository's older answers to a machine that shares it later", async () => {
    const later = `repo-later-${Date.now()}`;
    const first = `repo-first-${Date.now()}`;
    await machineA.team.share(later, "/work/later", 0);
    await machineA.team.share(first, "/work/first", 0);
    await record(machineA, "old-in-later", "What came first?", later);
    await sync(machineA, teamA);
    await record(machineA, "new-in-first", "What came next?", first);
    await sync(machineA, teamA);

    await machineB.team.share(first, "/home/bob/first", 0);
    await sync(machineB, teamB);
    expect(await machineB.answers.get("new-in-first")).toBeDefined();
    await machineB.team.share(later, "/home/bob/later", 0);
    await sync(machineB, teamB);
    expect(await machineB.answers.get("old-in-later")).toBeDefined();
  });

  it("counts usage once when a batch is sent again, or by two syncs at the same time", async () => {
    const before = await spentBy(teamA);
    await machineA.usage.add({ sessionId: "s", ts: Date.now(), model: "m", cost: 0.25 });
    await sync(machineA, teamA);
    await machineA.team.set("usage_id", "0");
    await sync(machineA, teamA);
    expect(await spentBy(teamA)).toBeCloseTo(before + 0.25, 10);

    await machineA.usage.add({ sessionId: "s", ts: Date.now(), model: "m", cost: 0.5 });
    await Promise.all([sync(machineA, teamA), sync(machineA, teamA)]);
    await sync(machineA, teamA);
    expect(await spentBy(teamA)).toBeCloseTo(before + 0.75, 10);
  });

  it("pushes the shared answers again to another team server", async () => {
    const id = `moved-${Date.now()}`;
    await record(machineA, id, `Where did it move? ${id}`);
    expect((await sync(machineA, teamA)).pushed.answers).toBe(1);
    const elsewhere = { ...teamA, url: "https://other-team.test" };
    expect((await sync(machineA, elsewhere)).pushed.answers).toBeGreaterThanOrEqual(1);
    expect((await sync(machineA, elsewhere)).pushed.answers).toBe(0);
  });

  it("sets aside an answer the server refuses, with the reason, and goes on with the others", async () => {
    const stamp = Date.now();
    await record(machineA, `long-${stamp}`, `A long one ${stamp}`, "repo-1", "x".repeat(4001));
    await record(machineA, `fine-${stamp}`, `A fine one ${stamp}`);
    await machineA.summaries.put({
      repoId: "repo-1",
      path: "big",
      blobHash: `tree:${stamp}`,
      summary: "y".repeat(4001),
      createdAt: 1,
    });

    const first = await sync(machineA, teamA);
    expect(first.pushed.answers).toBe(1);
    expect(first.refused).toEqual({ answers: 1, summaries: 1 });
    expect((await machineA.answers.get(`long-${stamp}`))?.shareError).toMatch(/at most 4000 characters/);
    expect((await machineA.summaries.get("repo-1", "big", `tree:${stamp}`))?.shareError).toMatch(/at most 4000/);

    const again = await sync(machineA, teamA);
    expect(again.refused).toEqual({ answers: 0, summaries: 0 });
    expect(again.pushed.answers).toBe(0);
    await sync(machineB, teamB);
    expect(await machineB.answers.get(`fine-${stamp}`)).toBeDefined();
    expect(await machineB.answers.get(`long-${stamp}`)).toBeUndefined();
  });

  it("forgets on every machine an answer one machine forgot", async () => {
    const id = `forget-${Date.now()}`;
    await record(machineA, id, `Which file parses config? ${id}`);
    await sync(machineA, teamA);
    await sync(machineB, teamB);
    expect(await machineB.answers.get(id)).toBeDefined();

    expect(await forgetAnswer(machineB, id)).toEqual({ shared: true });
    expect(await machineB.answers.get(id)).toBeUndefined();
    expect((await sync(machineB, teamB)).pushed.forgotten).toBe(1);
    expect((await sync(machineA, teamA)).pulled.removed).toBeGreaterThanOrEqual(1);
    expect(await machineA.answers.get(id)).toBeUndefined();
    expect((await sync(machineB, teamB)).pushed.forgotten).toBe(0);
  });

  it("keeps a forgotten answer local to this machine when it was never shared", async () => {
    const id = `local-forget-${Date.now()}`;
    await record(machineA, id, "Never shared", "repo-private");
    expect(await forgetAnswer(machineA, id)).toEqual({ shared: false });
    expect((await sync(machineA, teamA)).pushed.forgotten).toBe(0);
    expect(await forgetAnswer(machineA, id)).toBeNull();
  });

  it("fails without changing anything local when the server cannot be reached", async () => {
    const id = `offline-${Date.now()}`;
    await record(machineA, id, "Offline question");
    const offline = {
      ...teamA,
      fetch: (async () => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
    };
    await expect(sync(machineA, offline)).rejects.toThrow("network down");
    expect((await machineA.answers.get(id))?.shared).toBe(false);
  });
});
