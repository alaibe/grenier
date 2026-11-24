import { joinCode, sha256 } from "@grenier/core";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hash, SETUP_TOKEN, startWorker } from "../../support/worker.ts";

let mf: Miniflare;
let call: Awaited<ReturnType<typeof startWorker>>["call"];

beforeEach(async () => {
  ({ mf, call } = await startWorker());
  const setup = await call("/api/setup", SETUP_TOKEN, { body: { member: "ada", device: "ada-mbp" } });
  expect(setup.status).toBe(201);
}, 60_000);

afterEach(async () => {
  await mf.dispose();
});

const ADA = SETUP_TOKEN;
/** A repository's folder: members' agents write their answers there. */
const REPO = "repo:0123456789abcdef";
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

/** Invites someone, joins from a device, and has ada confirm the code; returns the new device's token. */
async function join(name: string, device = `${name}-mbp`, role: "member" | "admin" = "member"): Promise<string> {
  const invite = await json<{ id: string; secret: string }>(await call("/api/invites", ADA, { body: { name, role } }));
  const token = `gt_${name}_${device}_token_0123456789abcdef0123456789`;
  const nonce = "a".repeat(32);
  const asked = await call("/api/join", undefined, {
    body: { invite: invite.id, secret: invite.secret, device, tokenHash: hash(token), nonce },
  });
  expect(asked.status).toBe(202);
  const code = await joinCode(await sha256(invite.secret), nonce);
  expect((await call("/api/invites/confirm", ADA, { body: { code } })).status).toBe(200);
  return token;
}

let changeId = 0;
async function push(token: string, record: Record<string, unknown>, baseVersion = 0, check = false) {
  changeId += 1;
  const id = String(record.id);
  return json<{ applied: { version: number }[]; refused: { reason: string }[]; conflicts: { current: unknown }[] }>(
    await call("/api/changes", token, {
      body: {
        changes: [
          {
            id: `change-${changeId}`,
            recordId: id,
            baseVersion,
            changed: Object.keys(record).filter((key) => key !== "id"),
            record,
            check,
          },
        ],
      },
    }),
  );
}

async function pull(token: string, after = 0) {
  return json<{ records: { id: string; title: string; body: string; space: string; version: number }[] }>(
    await call(`/api/changes?after=${after}`, token),
  );
}

describe("setting up and joining", () => {
  it("sets up the first admin once, with the deploy's token only", async () => {
    expect((await call("/api/setup", "gt_wrong", { body: { member: "eve", device: "x" } })).status).toBe(401);
    expect((await call("/api/setup", SETUP_TOKEN, { body: { member: "eve", device: "x" } })).status).toBe(409);
    expect(await json(await call("/api/me", ADA))).toMatchObject({ name: "ada", role: "admin", device: "ada-mbp" });
  });

  it("lets a device in only once an admin confirms the code both screens show", async () => {
    const invite = await json<{ id: string; secret: string }>(
      await call("/api/invites", ADA, { body: { name: "bob" } }),
    );
    const token = "gt_bob_waiting_token_0123456789abcdef0123456789abcdef";
    const nonce = "b".repeat(32);
    await call("/api/join", undefined, {
      body: { invite: invite.id, secret: invite.secret, device: "bob-mbp", tokenHash: hash(token), nonce },
    });
    expect((await call("/api/me", token)).status).toBe(401);
    const code = await joinCode(await sha256(invite.secret), nonce);
    const { invites } = await json<{ invites: { code: string; device: string }[] }>(await call("/api/invites", ADA));
    expect(invites).toMatchObject([{ device: "bob-mbp", code }]);
    expect(
      (await call("/api/invites/confirm", ADA, { body: { code: code === "000000" ? "111111" : "000000" } })).status,
    ).toBe(404);
    expect((await call("/api/invites/confirm", ADA, { body: { code } })).status).toBe(200);
    expect(await json(await call("/api/me", token))).toMatchObject({ name: "bob", role: "member" });
    const reused = await call("/api/join", undefined, {
      body: { invite: invite.id, secret: invite.secret, device: "eve", tokenHash: hash("gt_eve"), nonce },
    });
    expect(reused.status).toBe(404);
  });

  it("refuses a join with a wrong secret, and lets only admins invite", async () => {
    const invite = await json<{ id: string }>(await call("/api/invites", ADA, { body: { name: "bob" } }));
    const wrong = await call("/api/join", undefined, {
      body: { invite: invite.id, secret: "00", device: "x", tokenHash: "0".repeat(64), nonce: "c".repeat(32) },
    });
    expect(wrong.status).toBe(404);
    const bob = await join("carol");
    expect((await call("/api/invites", bob, { body: { name: "dan" } })).status).toBe(403);
  });
});

describe("admins", () => {
  it("can make another member admin and take it back, and the team keeps at least one", async () => {
    const bob = await join("bob");
    expect((await call("/api/members/ada/role", ADA, { method: "PUT", body: { role: "member" } })).status).toBe(409);
    expect((await call("/api/members/ada", ADA, { method: "DELETE" })).status).toBe(409);
    expect((await call("/api/members/bob/role", ADA, { method: "PUT", body: { role: "admin" } })).status).toBe(200);
    expect((await call("/api/members/ada/role", bob, { method: "PUT", body: { role: "member" } })).status).toBe(200);
    expect((await call("/api/members/bob/role", bob, { method: "PUT", body: { role: "member" } })).status).toBe(409);
  });

  it("stops a removed member's devices at their next call", async () => {
    const bob = await join("bob");
    expect((await call("/api/me", bob)).status).toBe(200);
    expect((await call("/api/members/bob", ADA, { method: "DELETE" })).status).toBe(200);
    expect((await call("/api/me", bob)).status).toBe(401);
  });
});

describe("changes", () => {
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    space: "team",
    type: "Memory",
    kind: "fact",
    title: "Deploys on Friday",
    body: "Only before noon.",
    fields: { kind: "fact" },
    anchors: [],
    links: [],
    ...extra,
  });

  it("lists a member's records by type and words, without sealed ones", async () => {
    await push(ADA, record("t1", { type: "Task", kind: null, title: "Bump hono", fields: { status: "to-do" } }));
    await push(ADA, record("r1"));
    await push(ADA, { id: "m1", space: "me", type: "Sealed", title: "", body: "", sealed: "c2VhbGVk", fields: {} });
    const list = async (query: string) =>
      (await json<{ records: { id: string }[] }>(await call(`/api/records${query}`, ADA))).records.map((r) => r.id);
    expect(await list("?type=Task")).toEqual(["t1"]);
    expect((await list("")).sort()).toEqual(["r1", "t1"]);
    expect(await list("?q=friday")).toEqual(["r1"]);
  });

  it("numbers every change, and gives a teammate what changed after their cursor", async () => {
    const bob = await join("bob");
    const first = await push(ADA, record("r1"));
    expect(first.applied[0]?.version).toBe(1);
    const second = await push(ADA, record("r2", { title: "Reviews by two people" }));
    expect(second.applied[0]?.version).toBe(2);
    expect((await pull(bob)).records.map((entry) => entry.id)).toEqual(["r1", "r2"]);
    expect((await pull(bob, 1)).records.map((entry) => entry.id)).toEqual(["r2"]);
  });

  it("applies a change once, however many times it is sent", async () => {
    const body = {
      changes: [
        {
          id: "same",
          recordId: "r1",
          baseVersion: 0,
          changed: ["space", "type", "kind", "title", "fields"],
          record: record("r1"),
        },
      ],
    };
    const once = await json<{ applied: { version: number }[] }>(await call("/api/changes", ADA, { body }));
    const twice = await json<{ applied: { version: number }[] }>(await call("/api/changes", ADA, { body }));
    expect(twice.applied[0]?.version).toBe(once.applied[0]?.version);
  });

  it("merges two people's changes field by field, and refuses the editor's save over someone's edit", async () => {
    const bob = await join("bob");
    await push(ADA, record("r1", { space: REPO }));
    await push(bob, { id: "r1", body: "Before noon, never on a holiday." }, 1);
    await push(ADA, { id: "r1", title: "Deploys on Fridays" }, 1);
    await push(bob, { id: "r1", folder: "Releases" }, 1);
    const merged = (await pull(ADA)).records.find((entry) => entry.id === "r1");
    expect(merged).toMatchObject({
      title: "Deploys on Fridays",
      folder: "Releases",
      body: "Before noon, never on a holiday.",
    });
    const conflict = await push(ADA, { id: "r1", body: "Mine." }, 1, true);
    expect(conflict.conflicts[0]?.current).toMatchObject({ body: "Before noon, never on a holiday." });
    expect(
      (await push(ADA, { id: "r1", fields: { kind: "convention" }, kind: "convention" }, 1, true)).applied,
    ).toHaveLength(1);
  });

  it("refuses a record that breaks its type's rules or holds a key", async () => {
    const refused = await push(ADA, {
      id: "d1",
      space: "team",
      type: "Decision",
      title: "Use SQLite",
      fields: { owner: "ada" },
    });
    expect(refused.refused[0]?.reason).toContain("needs date");
    const secret = await push(ADA, record("k1", { body: "AKIAABCDEFGHIJKLMNOP" }));
    expect(secret.refused[0]?.reason).toContain("looks like a key");
    const sealed = await push(ADA, record("k2", { title: "AKIAABCDEFGHIJKLMNOP", sealed: "c2VhbGVk" }));
    expect(sealed.refused[0]?.reason).toContain("only a record in me is sealed");
    for (const [folder, why] of [
      ["../etc", "cannot be named .."],
      ["Ops//Deploys", "is not empty"],
      [" Ops", "no space around it"],
      ["a/b/c/d/e/f/g/h/i", "at most 8 deep"],
      ["AKIAABCDEFGHIJKLMNOP", "looks like a key"],
    ]) {
      expect((await push(ADA, record("f1", { folder }))).refused[0]?.reason).toContain(why);
    }
    const shown = await push(ADA, {
      id: "m2",
      space: "me",
      type: "Sealed",
      title: "",
      body: "",
      sealed: "c2VhbGVk",
      fields: {},
      folder: "Health",
    });
    expect(shown.refused[0]?.reason).toContain("keeps its folder sealed");
  });

  it("keeps a member's me space to that member, and a custom space to its members", async () => {
    const bob = await join("bob");
    await push(ADA, { id: "m1", space: "me", type: "Sealed", title: "", body: "", sealed: "c2VhbGVk", fields: {} });
    expect((await pull(ADA)).records.map((entry) => entry.space)).toEqual([expect.stringMatching(/^me:/)]);
    expect((await pull(bob)).records).toEqual([]);
    expect((await call("/api/spaces", ADA, { body: { name: "leads", members: ["ada"] } })).status).toBe(201);
    await push(ADA, record("l1", { space: "space:leads" }));
    expect((await pull(bob)).records).toEqual([]);
    const cleo = await join("cleo", "cleo-mbp", "admin");
    expect((await push(cleo, record("l2", { space: "space:leads" }))).refused[0]?.reason).toContain("no space");
  });

  it("keeps every version, with who made it", async () => {
    const bob = await join("bob");
    await push(ADA, record("r1", { space: REPO }));
    await push(bob, { id: "r1", body: "Changed." }, 1);
    const { history } = await json<{ history: { version: number; author: string; device: string }[] }>(
      await call("/api/records/r1/history", ADA),
    );
    expect(history.map((entry) => [entry.version, entry.author, entry.device])).toEqual([
      [1, "ada", "ada-mbp"],
      [2, "bob", "bob-mbp"],
    ]);
  });
});

describe("what members write", () => {
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    space: "team",
    type: "Memory",
    kind: "fact",
    title: "Deploys on Friday",
    body: "Only before noon.",
    fields: { kind: "fact" },
    ...extra,
  });

  it("keeps a member to their me, their agents' answers in a repository's folder, and the requests they run", async () => {
    const bob = await join("bob");
    const refused = async (change: Record<string, unknown>, base = 0) =>
      (await push(bob, change, base)).refused[0]?.reason;
    expect(await refused(record("t1"))).toContain("only an admin writes there");
    expect(await refused({ id: "s1", space: "team", type: "Skill", title: "notes", fields: { files: {} } })).toContain(
      "only an admin writes there",
    );
    expect((await push(bob, record("mine", { space: "me" }))).applied).toHaveLength(1);
    expect((await push(bob, record("answer", { space: REPO }))).applied).toHaveLength(1);
    expect(await refused({ id: "answer", space: "team" }, 1)).toContain("only an admin writes there");
    expect(await refused(record("doc", { space: REPO, type: "Doc", kind: null, fields: {} }))).toContain(
      "only an admin writes there",
    );

    await push(ADA, {
      id: "task",
      space: "team",
      type: "Task",
      title: "Bump hono",
      fields: { status: "to-do", routine: "r" },
    });
    const running = { id: "task", fields: { status: "doing", routine: "r", machine: "bob-mbp" } };
    expect(await refused(running, 1)).toContain("only an admin writes there");
    await call("/api/runs", bob, { body: { id: "run1", routineId: "r", taskId: "task", status: "running" } });
    expect((await push(bob, running, 1)).applied).toHaveLength(1);
    expect(await refused({ id: "task", title: "Something else" }, 2)).toContain("only an admin writes there");
    expect((await call("/api/runs/run1/thumbs", bob, { body: { up: true } })).status).toBe(403);
  });
});

describe("requests", () => {
  async function routineAndTask(token: string) {
    await push(token, {
      id: "routine",
      space: "team",
      type: "Routine",
      title: "Update dependencies",
      fields: { versions: [{ version: 1, prompt: "Update", status: "production" }], trigger: "request", repo: "app" },
    });
    await push(token, {
      id: "task",
      space: "team",
      type: "Task",
      title: "Bump hono",
      fields: { status: "to-do", routine: "routine" },
    });
  }
  const state = (token: string, room: number, repos = ["app"]) =>
    call("/api/machines/me", token, { method: "PUT", body: { state: "available", room, repos, agents: ["claude"] } });

  it("offers a request to the available machine with the most room that has its repo, and to one at a time", async () => {
    const bob = await join("bob");
    await routineAndTask(ADA);
    await state(ADA, 0.3);
    await state(bob, 0.8);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", ADA, { method: "POST" }))).offer).toBeNull();
    const offer = await json<{ offer: { task: { id: string } } }>(
      await call("/api/work/claim", bob, { method: "POST" }),
    );
    expect(offer.offer.task.id).toBe("task");
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", bob, { method: "POST" }))).offer).toBeNull();
  });

  it("takes a routine's schedule, and a change to it", async () => {
    const routine = (schedule: string) => ({
      id: "nightly",
      space: "team",
      type: "Routine",
      title: "Nightly digest",
      fields: { versions: [{ version: 1, prompt: "Digest", status: "production" }], trigger: "schedule", schedule },
    });
    expect((await push(ADA, routine("mon 09:00"))).applied).toHaveLength(1);
    expect((await push(ADA, routine("hourly"), 1)).applied).toHaveLength(1);
  });

  it("offers a request in a space only to the machines of its members", async () => {
    const bob = await join("bob");
    await call("/api/spaces", ADA, { body: { name: "leads", members: ["ada"] } });
    await routineAndTask(ADA);
    await push(ADA, { id: "task", space: "space:leads" }, 1);
    await state(ADA, 0.3);
    await state(bob, 0.8);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", bob, { method: "POST" }))).offer).toBeNull();
    const offer = await json<{ offer: { task: { id: string } } }>(
      await call("/api/work/claim", ADA, { method: "POST" }),
    );
    expect(offer.offer.task.id).toBe("task");
  });

  it("goes to the next machine when one declines, and to none without its repo", async () => {
    const bob = await join("bob");
    await routineAndTask(ADA);
    await state(ADA, 0.3);
    await state(bob, 0.8, ["other"]);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", bob, { method: "POST" }))).offer).toBeNull();
    await state(bob, 0.8);
    await call("/api/work/claim", bob, { method: "POST" });
    await call("/api/work/task/decline", bob, { method: "POST" });
    const offer = await json<{ offer: { task: { id: string } } | null }>(
      await call("/api/work/claim", ADA, { method: "POST" }),
    );
    expect(offer.offer?.task.id).toBe("task");
  });

  it("offers a collector's request only to its person's machines", async () => {
    const bob = await join("bob", "bob-mbp", "admin");
    await push(bob, {
      id: "collector",
      space: "team",
      type: "Routine",
      title: "My meetings",
      fields: {
        versions: [{ version: 1, prompt: "Gather", status: "production" }],
        trigger: "request",
        collector: "yes",
      },
    });
    await push(ADA, {
      id: "gather",
      space: "team",
      type: "Task",
      title: "Gather today",
      fields: { status: "to-do", routine: "collector" },
    });
    await state(ADA, 0.9, []);
    await state(bob, 0.1, []);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", ADA, { method: "POST" }))).offer).toBeNull();
    const offer = await json<{ offer: { task: { id: string } } | null }>(
      await call("/api/work/claim", bob, { method: "POST" }),
    );
    expect(offer.offer?.task.id).toBe("gather");
  });

  it("turns a webhook call into a request for its routine", async () => {
    await routineAndTask(ADA);
    const { path } = await json<{ path: string }>(await call("/api/webhooks", ADA, { body: { routine: "routine" } }));
    const hooked = await mf.dispatchFetch(`https://team.test${path}`, {
      method: "POST",
      body: JSON.stringify({ title: "Bump zod" }),
    });
    expect(hooked.status).toBe(201);
    const titles = (await pull(ADA)).records.map((entry) => entry.title);
    expect(titles).toContain("Bump zod");
    expect((await mf.dispatchFetch(`https://team.test${path}x`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("usage", () => {
  it("shows each member their own machines' usage, and admins everyone's", async () => {
    const bob = await join("bob");
    const row = {
      day: "2026-11-20",
      repo: "app",
      requests: 3,
      inputTokens: 10,
      cacheWriteTokens: 0,
      cacheReadTokens: 5,
      outputTokens: 2,
      cost: 1.5,
      routineMinutes: 0,
    };
    await call("/api/usage", ADA, { method: "PUT", body: { rows: [row] } });
    await call("/api/usage", bob, { method: "PUT", body: { rows: [{ ...row, cost: 2 }] } });
    const mine = await json<{ usage: { member: string }[] }>(await call("/api/usage?since=2026-11-01", bob));
    expect(mine.usage.map((entry) => entry.member)).toEqual(["bob"]);
    const all = await json<{ usage: { member: string }[] }>(await call("/api/usage?since=2026-11-01", ADA));
    expect(all.usage.map((entry) => entry.member).sort()).toEqual(["ada", "bob"]);
  });
});

describe("the remote MCP server and the web view", () => {
  it("answers recall with records marked as untrusted, and needs a token", async () => {
    await push(ADA, {
      id: "r1",
      space: "team",
      type: "Memory",
      kind: "fact",
      title: "Deploys on Friday",
      body: "Only before noon.",
      fields: { kind: "fact" },
    });
    const rpc = (body: unknown, token: string | null = ADA) => call("/mcp", token ?? undefined, { body });
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, null)).status).toBe(401);
    const tools = await json<{ result: { tools: { name: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(["recall", "query", "request"]);
    const found = await json<{ result: { structuredContent: { results: { body: string }[] } } }>(
      await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "recall", arguments: { query: "deploys friday" } },
      }),
    );
    expect(found.result.structuredContent.results[0]?.body).toMatch(/^<untrusted-data-[0-9a-f]+ id="r1"/);
  });

  it("signs a browser in once with a link a device made", async () => {
    const { path } = await json<{ path: string }>(await call("/api/weblinks", ADA, { method: "POST" }));
    const code = path.split("=")[1];
    const first = await json<{ token: string }>(await call("/web/login", undefined, { body: { code } }));
    expect(await json(await call("/api/me", first.token))).toMatchObject({ name: "ada", device: "web" });
    expect((await call("/web/login", undefined, { body: { code } })).status).toBe(404);
    const page = await mf.dispatchFetch("https://team.test/");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
