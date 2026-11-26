import { joinCode, sha256 } from "@grenier/core";
import { describe, expect, it } from "vitest";
import { hash, SETUP_TOKEN } from "../../support/worker.ts";
import { ADA, call, join, json, mf, pull, push } from "./harness.ts";
import { openPage } from "./page.ts";

/** A repository's folder: members' agents write their answers there. */
const REPO = "repo:0123456789abcdef";

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

describe("machines", () => {
  it("names each machine by id, and lets a member remove their own machines only, an admin any", async () => {
    const bob = await join("bob");
    const bobAir = await join("bob", "bob-air");
    const machines = async () =>
      (await json<{ machines: { id: string; name: string }[] }>(await call("/api/machines", ADA))).machines;
    const idOf = async (token: string) => (await json<{ deviceId: string }>(await call("/api/me", token))).deviceId;
    const ids = Object.fromEntries((await machines()).map((machine) => [machine.name, machine.id]));
    expect(await idOf(ADA)).toBe(ids["ada-mbp"]);
    expect(await idOf(bobAir)).toBe(ids["bob-air"]);

    const remove = (token: string, name: string) => call(`/api/devices/${ids[name]}`, token, { method: "DELETE" });
    expect((await remove(bob, "ada-mbp")).status).toBe(403);
    expect((await remove(bob, "bob-air")).status).toBe(200);
    expect((await call("/api/me", bobAir)).status).toBe(401);
    expect((await call("/api/me", ADA)).status).toBe(200);
    expect((await remove(ADA, "bob-mbp")).status).toBe(200);
    expect((await call("/api/me", bob)).status).toBe(401);
    expect((await machines()).map((machine) => machine.name)).toEqual(["ada-mbp"]);
  });
});

describe("changes", () => {
  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    top: "team",
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
    await push(ADA, { id: "m1", top: "me", type: "Sealed", title: "", body: "", sealed: "c2VhbGVk", fields: {} });
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
          changed: ["top", "type", "kind", "title", "fields"],
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
    await push(ADA, record("r1", { top: REPO }));
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

  it("refuses a new record that names no top folder", async () => {
    const { top: _top, ...nowhere } = record("n1");
    expect((await push(ADA, nowhere)).refused[0]?.reason).toContain("names its top folder");
  });

  it("refuses a record that breaks its type's rules or holds a key", async () => {
    const refused = await push(ADA, {
      id: "d1",
      top: "team",
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
      top: "me",
      type: "Sealed",
      title: "",
      body: "",
      sealed: "c2VhbGVk",
      fields: {},
      folder: "Health",
    });
    expect(shown.refused[0]?.reason).toContain("keeps its folder sealed");
  });

  it("keeps a member's me top to that member", async () => {
    const bob = await join("bob");
    await push(ADA, { id: "m1", top: "me", type: "Sealed", title: "", body: "", sealed: "c2VhbGVk", fields: {} });
    expect((await pull(ADA)).records.map((entry) => entry.top)).toEqual([expect.stringMatching(/^me:/)]);
    expect((await pull(bob)).records).toEqual([]);
  });

  it("keeps every version, with who made it", async () => {
    const bob = await join("bob");
    await push(ADA, record("r1", { top: REPO }));
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
    top: "team",
    type: "Memory",
    kind: "fact",
    title: "Deploys on Friday",
    body: "Only before noon.",
    fields: { kind: "fact" },
    ...extra,
  });

  it("keeps a member to their me, their agents' pages in a repository's folder, and the requests they run", async () => {
    const bob = await join("bob");
    const refused = async (change: Record<string, unknown>, base = 0) =>
      (await push(bob, change, base)).refused[0]?.reason;
    expect(await refused(record("t1"))).toContain("only an admin writes there");
    expect(await refused({ id: "s1", top: "team", type: "Skill", title: "notes", fields: { files: {} } })).toContain(
      "only an admin writes there",
    );
    expect((await push(bob, record("mine", { top: "me" }))).applied).toHaveLength(1);
    expect((await push(bob, record("answer", { top: REPO }))).applied).toHaveLength(1);
    expect(await refused({ id: "answer", top: "team" }, 1)).toContain("only an admin writes there");
    expect((await push(bob, record("doc", { top: REPO, type: "Doc", kind: null, fields: {} }))).applied).toHaveLength(
      1,
    );
    expect(
      await refused(
        record("decision", {
          top: REPO,
          type: "Decision",
          kind: null,
          fields: { owner: "bob", date: "2026-11-26", reason: "Faster." },
        }),
      ),
    ).toContain("only an admin writes there");

    await push(ADA, {
      id: "r",
      top: "team",
      type: "Routine",
      title: "Bump",
      body: "Bump",
      fields: {},
    });
    await push(ADA, {
      id: "task",
      top: "team",
      type: "Task",
      title: "Bump hono",
      fields: { status: "to-do", routine: "r" },
    });
    const running = { id: "task", fields: { status: "doing", routine: "r", machine: "bob-mbp" } };
    expect(await refused(running, 2)).toContain("only an admin writes there");
    await call("/api/machines/me", bob, { method: "PUT", body: { state: "available", room: 1, agents: ["claude"] } });
    await call("/api/work/claim", bob, { method: "POST" });
    await call("/api/runs", bob, { body: { id: "run1", routineId: "r", taskId: "task", status: "running" } });
    expect((await push(bob, running, 2)).applied).toHaveLength(1);
    expect(await refused({ id: "task", title: "Something else" }, 3)).toContain("only an admin writes there");
  });

  it("takes a task's run only from the machine that holds the task, and its updates only from that machine", async () => {
    const bob = await join("bob");
    const cleo = await join("cleo");
    await push(ADA, {
      id: "r",
      top: "team",
      type: "Routine",
      title: "Bump",
      body: "Bump",
      fields: {},
    });
    await push(ADA, {
      id: "task",
      top: "team",
      type: "Task",
      title: "Bump hono",
      fields: { status: "to-do", routine: "r" },
    });
    const run = (token: string, body: Record<string, unknown>) =>
      call("/api/runs", token, { body: { routineId: "r", startedAt: 1, ...body } });
    const runFields = (status: string) => ({
      id: "task",
      fields: { status, routine: "r", machine: "bob-mbp", result: "Bumped." },
    });

    expect((await run(bob, { id: "early", taskId: "task", status: "running" })).status).toBe(409);
    await call("/api/machines/me", bob, { method: "PUT", body: { state: "available", room: 1, agents: ["claude"] } });
    expect(
      (await json<{ offer: { task: { id: string } } }>(await call("/api/work/claim", bob, { method: "POST" }))).offer
        .task.id,
    ).toBe("task");

    expect((await run(bob, { id: "bob-run", taskId: "task", status: "running" })).status).toBe(200);
    expect((await run(cleo, { id: "cleo-run", taskId: "task", status: "running" })).status).toBe(409);
    expect((await run(cleo, { id: "bob-run", taskId: "task", status: "failed" })).status).toBe(403);
    // A run of no task, then named as the task's, frees nobody's claim and proves nothing.
    expect((await run(cleo, { id: "cleo-own", status: "running" })).status).toBe(200);
    expect((await run(cleo, { id: "cleo-own", taskId: "task", status: "done" })).status).toBe(200);
    expect((await push(cleo, runFields("done"), 2)).refused[0]?.reason).toContain("only an admin writes there");
    expect((await call("/api/work/task/renew", bob, { method: "POST" })).status).toBe(200);

    expect((await push(bob, runFields("doing"), 2)).applied).toHaveLength(1);
    expect((await run(bob, { id: "bob-run", status: "done", endedAt: 2, cost: 0.5 })).status).toBe(200);
    expect((await call("/api/work/task/renew", bob, { method: "POST" })).status).toBe(409);
    expect((await push(bob, runFields("done"), 3)).applied).toHaveLength(1);
    const { runs } = await json<{ runs: { id: string; status: string; task_id: string | null }[] }>(
      await call("/api/runs?routine=r", ADA),
    );
    expect(runs.map((entry) => [entry.id, entry.status, entry.task_id]).sort()).toEqual([
      ["bob-run", "done", "task"],
      ["cleo-own", "done", null],
    ]);
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

describe("the web view", () => {
  it("goes to a place with G then its letter, the first G's time running out not cutting the next one short", async () => {
    const timers: (() => void)[] = [];
    const pending = new Set<number>();
    const clock = {
      setTimeout: (run: () => void) => {
        timers.push(run);
        pending.add(timers.length);
        return timers.length;
      },
      clearTimeout: (timer: unknown) => pending.delete(timer as number),
    };
    const page = openPage(ADA, (path, init) => mf.dispatchFetch(`https://team.test${path}`, init as never), clock);
    await expect.poll(() => page.nav.children.length).toBeGreaterThan(0);
    const current = () => page.nav.find((node) => node.getAttribute("aria-current") === "page").textContent;
    page.press("g");
    page.press("r");
    expect(current()).toBe("Routines");
    page.press("g");
    if (pending.has(1)) timers[0]?.();
    page.press("m");
    expect(current()).toBe("Team");
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
