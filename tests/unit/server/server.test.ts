import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash, startWorker } from "../../support/worker.ts";

const ADMIN = "gt_admin-test-token";
let mf: Miniflare;
let call: Awaited<ReturnType<typeof startWorker>>["call"];
let member: string;

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const answer = (id: string, question: string, text = "In src/proxy.ts.") => ({
  id,
  repoId: "repo-1",
  question,
  answer: text,
  sources: [{ path: "src/proxy.ts", blobHash: "a".repeat(40) }],
  createdAt: 1_000,
});

beforeAll(async () => {
  ({ mf, call } = await startWorker());
  const db = await mf.getD1Database("DB");
  await db
    .prepare("INSERT INTO members (id, name, token_hash, role, created_at) VALUES ('m0', 'ada', ?, 'admin', 0)")
    .bind(hash(ADMIN))
    .run();
  const created = await call("/api/members", ADMIN, json({ name: "bob" }));
  member = ((await created.json()) as { token: string }).token;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("authentication", () => {
  it("refuses a call without a token or with an unknown one", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", "gt_nope")).status).toBe(401);
    expect(await (await call("/api/me", ADMIN)).json()).toMatchObject({ name: "ada", role: "admin" });
  });

  it("lets an admin invite a member, whose token works, and nobody else", async () => {
    expect(member).toMatch(/^gt_[\w-]{43}$/);
    expect(await (await call("/api/me", member)).json()).toMatchObject({ name: "bob", role: "member" });
    expect((await call("/api/members", member, json({ name: "eve" }))).status).toBe(403);
    expect((await call("/api/members", ADMIN, json({ name: "bob" }))).status).toBe(409);
  });

  it("stores tokens hashed, never as they are", async () => {
    const db = await mf.getD1Database("DB");
    const rows = await db.prepare("SELECT token_hash FROM members").all<{ token_hash: string }>();
    expect(JSON.stringify(rows.results)).not.toContain(member);
    expect(rows.results.map((row) => row.token_hash)).toContain(hash(member));
  });
});

describe("shared cache", () => {
  it("returns pushed answers to anyone pulling the repository, newer than their cursor", async () => {
    expect((await call("/api/answers", member, json({ answers: [answer("a1", "Where is the proxy?")] }))).status).toBe(
      200,
    );

    const first = (await (await call("/api/sync?repos=repo-1", ADMIN)).json()) as {
      answers: { id: string; author: string; deleted: boolean; sources: unknown }[];
      cursors: { answers: number; summaries: number };
    };
    expect(first.answers).toMatchObject([
      { id: "a1", author: "bob", deleted: false, sources: [{ path: "src/proxy.ts", blobHash: "a".repeat(40) }] },
    ]);

    const again = (await (await call(`/api/sync?repos=repo-1&answers=${first.cursors.answers}`, ADMIN)).json()) as {
      answers: unknown[];
    };
    expect(again.answers).toEqual([]);
    expect(((await (await call("/api/sync?repos=other", ADMIN)).json()) as { answers: unknown[] }).answers).toEqual([]);
  });

  it("marks an older answer to the same question as deleted when a new one arrives", async () => {
    const before = ((await (await call("/api/sync?repos=repo-1", ADMIN)).json()) as { cursors: { answers: number } })
      .cursors;
    await call(
      "/api/answers",
      ADMIN,
      json({ answers: [answer("a2", "  WHERE IS THE PROXY? ", "Moved to src/gateway.ts.")] }),
    );

    const changes = (await (await call(`/api/sync?repos=repo-1&answers=${before.answers}`, member)).json()) as {
      answers: { id: string; deleted: boolean }[];
    };
    expect(changes.answers.map((row) => [row.id, row.deleted])).toEqual([
      ["a1", true],
      ["a2", false],
    ]);
  });

  it("refuses an answer or summary that copies code (rule 4)", async () => {
    const code = `\`\`\`ts\n${"const x = 1;\n".repeat(20)}\`\`\``;
    const refused = await call("/api/answers", member, json({ answers: [answer("a3", "q", code)] }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("at most 10 lines of code");
    const summary = { repoId: "repo-1", path: "x.ts", blobHash: "b", summary: "x".repeat(5000), createdAt: 1 };
    expect((await call("/api/summaries", member, json({ summaries: [summary] }))).status).toBe(400);
  });

  it("shares summaries the same way", async () => {
    const summary = { repoId: "repo-1", path: "src", blobHash: "tree:1", summary: "The proxy.", createdAt: 1 };
    expect((await call("/api/summaries", member, json({ summaries: [summary] }))).status).toBe(200);
    const sync = (await (await call("/api/sync?repos=repo-1", ADMIN)).json()) as { summaries: unknown[] };
    expect(sync.summaries).toMatchObject([{ path: "src", summary: "The proxy.", author: "bob" }]);
  });

  it("refuses malformed batches", async () => {
    expect((await call("/api/answers", member, json({ answers: [{ id: "x" }] }))).status).toBe(400);
    expect((await call("/api/answers", member, { method: "POST", body: "not json" })).status).toBe(200);
  });
});

describe("team budgets and usage", () => {
  const day = new Date().toISOString().slice(0, 10);
  const usage = (cost: number) => ({
    day,
    requests: 1,
    inputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 900,
    outputTokens: 50,
    cost,
    saved: 0.01,
    answerHits: 1,
  });

  it("adds each member's spending to today's team total and compares it with the limits", async () => {
    expect((await call("/api/budget", member, { method: "PUT", body: JSON.stringify({ team: 1 }) })).status).toBe(403);
    expect(
      (await call("/api/budget", ADMIN, { method: "PUT", body: JSON.stringify({ team: 1, member: 0.5 }) })).status,
    ).toBe(200);

    await call("/api/usage", member, json({ usage: [usage(0.75)] }));
    await call("/api/usage", ADMIN, json({ usage: [usage(0.5)] }));

    expect(await (await call("/api/budget", member)).json()).toEqual({
      day,
      team: { limit: 1, spent: 1.25 },
      member: { limit: 0.5, spent: 0.75 },
    });
  });

  it("shows usage per member and day on the dashboard, for admins only", async () => {
    expect((await call("/api/dashboard", member)).status).toBe(403);
    const board = (await (await call("/api/dashboard", ADMIN)).json()) as {
      usage: { member: string; requests: number; cost: number }[];
      members: { name: string }[];
      today: { total: number };
    };
    expect(board.usage.map((row) => [row.member, row.requests, row.cost])).toEqual([
      ["ada", 1, 0.5],
      ["bob", 1, 0.75],
    ]);
    expect(board.members.map((row) => row.name)).toEqual(["ada", "bob"]);
    expect(board.today.total).toBe(1.25);
  });

  it("serves the dashboard page without needing a token to load it", async () => {
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Grenier team</title>");
  });

  it("refuses negative or malformed usage", async () => {
    expect((await call("/api/usage", member, json({ usage: [{ ...usage(1), cost: -1 }] }))).status).toBe(400);
    expect((await call("/api/usage", member, json({ usage: [{ ...usage(1), day: "today" }] }))).status).toBe(400);
  });
});

describe("revocation", () => {
  it("answers a revoked token's next call with 401", async () => {
    expect((await call("/api/me", member)).status).toBe(200);
    expect((await call("/api/members/bob/revoke", ADMIN, { method: "POST" })).status).toBe(200);
    expect((await call("/api/me", member)).status).toBe(401);
    expect((await call("/api/members/ada/revoke", ADMIN, { method: "POST" })).status).toBe(400);
  });
});
