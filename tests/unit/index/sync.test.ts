import { syncOnce, type TeamClient } from "@grenier/index";
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

const sync = (store: Store, team: TeamClient, shareAll = false) =>
  syncOnce({ store, embedder: null, team, savedOf: (row) => (row.cacheReadTokens ?? 0) / 1_000_000, shareAll });

async function record(store: Store, id: string, question: string, repoId = "repo-1") {
  await store.answers.add(
    { id, repoId, question, answer: `Answer to ${question}`, createdAt: Date.now(), author: "local" },
    [{ path: "src/a.ts", blobHash: "1".repeat(40) }],
  );
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
