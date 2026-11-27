import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newVaultKey, TEAM_PROTOCOL } from "@grenier/core";
import { remember, syncOnce, type TeamClient } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestAdmin, testAdmin } from "../../../support/gateway.ts";
import { storeDeps, TableEmbedder, TestRepo } from "../../../support/repo.ts";
import { SETUP_TOKEN, startWorker } from "../../../support/worker.ts";

let store: Store;
let dir: string;
let admin: TestAdmin;
let team: TeamClient | null;
let synced: number;
let embedder: TableEmbedder | null;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  await store.state.set("team_member", "ada");
  dir = mkdtempSync(join(tmpdir(), "grenier-admin-"));
  team = null;
  synced = 0;
  embedder = null;
  admin = testAdmin(store, dir, {
    storeDeps: () => storeDeps(store, embedder),
    team: () => team,
    sync: async () => {
      synced += 1;
      return null;
    },
  });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init?: RequestInit & { origin?: string }) => admin.call(path, init);

describe("the editor's records", () => {
  it("writes, lists, searches, edits and retires records for the editor", async () => {
    const made = await call("/records", {
      method: "POST",
      body: JSON.stringify({
        type: "Task",
        title: "Use SQLite",
        fields: { status: "to-do" },
      }),
    });
    expect(made.status).toBe(201);
    const { id, ...saved } = (await made.json()) as { id: string; waiting: boolean; team: boolean };
    expect(saved).toMatchObject({ waiting: true, team: false });
    expect(((await (await call("/overview")).json()) as { waiting: number }).waiting).toBe(0);
    const refused = await call("/records", {
      method: "POST",
      body: JSON.stringify({ type: "Task", title: "No status" }),
    });
    expect(refused.status).toBe(400);

    const listed = (await (await call("/records?type=Task")).json()) as { records: { id: string }[] };
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
    expect(((await (await call("/records?type=Task")).json()) as { records: unknown[] }).records).toEqual([]);
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
      call("/folders/move", { method: "POST", body: JSON.stringify({ top: "team", ...body }) });
    expect((await move({ from: "Ops", to: "Ops/Inner" })).status).toBe(400);
    expect(await (await move({ from: "Ops", to: "Infra/Operations" })).json()).toEqual({ moved: 2 });
    expect((await store.records.get(plan))?.folder).toBe("Infra/Operations");
    expect((await store.records.get(deep))?.folder).toBe("Infra/Operations/Deploys");
    expect(await (await move({ from: "Infra", to: "Infra", toTop: "me" })).json()).toEqual({ moved: 2 });
    expect((await store.records.get(deep))?.top).toBe("me");
    expect((await pages()).find((page) => page.title === "Elsewhere")?.folder).toBe("Opsx");
  });

  it("saves straight to a team store that speaks this protocol, and hands back a teammate's version when they changed the same field", async () => {
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
    const waiting = (await (
      await call("/records", { method: "POST", body: JSON.stringify({ type: "Doc", title: "Before any sync" }) })
    ).json()) as { waiting?: boolean };
    expect(waiting.waiting).toBe(true);
    expect(sent).toEqual([]);

    await store.state.set("team_protocol", String(TEAM_PROTOCOL));
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

  it("embeds a page saved straight to the team store", async () => {
    embedder = new TableEmbedder({ Runbook: [1, 0, 0] });
    await store.state.set("team_protocol", String(TEAM_PROTOCOL));
    const sent: { changes: { record: Record<string, unknown> }[] }[] = [];
    team = {
      url: "https://team.test",
      token: "gt_x",
      fetch: (async (_url: unknown, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({ applied: [{ version: sent.length }], refused: [], conflicts: [] });
      }) as unknown as typeof fetch,
    };
    const made = (await (
      await call("/records", {
        method: "POST",
        body: JSON.stringify({
          type: "Doc",
          title: "Runbook",
          body: "Deploy on Friday.",
          top: "team",
          folder: "billing/Runbooks",
        }),
      })
    ).json()) as { id: string };
    expect(sent[0]?.changes[0]?.record).toMatchObject({ top: "team", folder: "billing/Runbooks" });
    await call(`/records/${made.id}`, { method: "PUT", body: JSON.stringify({ body: "Deploy on Monday." }) });
    expect((await store.records.vectors(["team"], "table")).map((row) => row.id)).toEqual([made.id]);
  });

  it("shows a Me page's history from this machine, since the team store holds it sealed", async () => {
    const asked: string[] = [];
    team = {
      url: "https://team.test",
      token: "gt_x",
      fetch: (async (url: URL) => {
        asked.push(url.pathname);
        return Response.json({ history: [{ version: 3, snapshot: { sealed: true } }] });
      }) as unknown as typeof fetch,
    };
    const made = (await (
      await call("/records", {
        method: "POST",
        body: JSON.stringify({ title: "Dentist", body: "Tuesday.", top: "me" }),
      })
    ).json()) as { id: string };
    await store.history.add({
      recordId: made.id,
      version: 3,
      author: "ada",
      device: "ada-mbp",
      ts: 1,
      snapshot: { title: "Dentist", body: "Monday." },
    });
    const history = (await (await call(`/records/${made.id}/history`)).json()) as {
      history: { snapshot: { body?: string } }[];
    };
    expect(history.history.map((entry) => entry.snapshot.body)).toEqual(["Monday."]);
    expect(asked).toEqual([]);
  });
});

describe("a librarian's suggestion", () => {
  it("retires its page when accepted, and goes either way", async () => {
    const deps = await storeDeps(store);
    const person = { id: "p", name: "p", scopes: ["*"] };
    const page = await remember(deps, person, null, { title: "Old runbook", top: "team" });
    const suggest = async () =>
      (
        await remember(deps, person, null, {
          type: "Suggestion",
          title: "Old runbook: stale",
          top: "team",
          fields: { target: page.id, change: { retire: true }, reason: "Stale." },
        })
      ).id;
    const dismissed = await suggest();
    await call(`/records/${dismissed}/decide`, { method: "POST", body: JSON.stringify({ accept: false }) });
    expect((await store.records.get(page.id))?.retiredAt).toBeNull();
    expect((await store.records.get(dismissed))?.retiredAt).not.toBeNull();
    const accepted = await suggest();
    expect(
      (await call(`/records/${accepted}/decide`, { method: "POST", body: JSON.stringify({ accept: true }) })).status,
    ).toBe(200);
    expect((await store.records.get(page.id))?.retiredAt).not.toBeNull();
    expect((await call(`/records/${accepted}/decide`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("the change to a file a record was written from", () => {
  it("shows the version it was written from and the one there is now", async () => {
    const repo = new TestRepo({ "router.ts": "export function route() {}\n" });
    try {
      await repo.ready();
      const deps = await storeDeps(store);
      const kept = await remember(deps, { id: "c", name: "claude", scopes: ["*"] }, repo.repo, {
        title: "Where are requests routed?",
        body: "route() in router.ts.",
        files: ["router.ts"],
        top: "me",
      });
      repo.write("router.ts", "export function route(path: string) {}\n");
      const diff = await admin.reply("GET", `/records/${kept.id}/diff?path=router.ts`);
      expect(diff).toEqual({
        status: 200,
        body: {
          path: "router.ts",
          before: "export function route() {}\n",
          now: "export function route(path: string) {}\n",
        },
      });
      expect((await admin.reply("GET", `/records/${kept.id}/diff?path=other.ts`))?.status).toBe(404);
    } finally {
      repo.remove();
    }
  });
});

describe("a Me page moved to Team while online", () => {
  let mf: Miniflare;
  let workerFetch: typeof fetch;

  beforeEach(async () => {
    ({ mf, fetch: workerFetch } = await startWorker());
    await workerFetch("https://team.test/api/setup", {
      method: "POST",
      headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ member: "ada", device: "ada-mbp" }),
    });
  }, 60_000);

  afterEach(async () => {
    await mf.dispose();
  });

  it("reaches the team store in the clear, as sync would send it", async () => {
    team = { url: "https://team.test", token: SETUP_TOKEN, fetch: workerFetch };
    const made = (await (
      await call("/records", {
        method: "POST",
        body: JSON.stringify({ title: "Dentist", body: "Tuesday.", top: "me" }),
      })
    ).json()) as { id: string };
    await syncOnce({ store, team, embedder: null, personalKey: newVaultKey() });
    expect(await store.state.get("team_protocol")).toBe(String(TEAM_PROTOCOL));

    const moved = await call(`/records/${made.id}`, { method: "PUT", body: JSON.stringify({ top: "team" }) });
    expect(await moved.json()).toEqual({ saved: made.id });
    const pulled = (await (
      await workerFetch("https://team.test/api/changes?after=0", {
        headers: { authorization: `Bearer ${SETUP_TOKEN}` },
      })
    ).json()) as { records: { id: string }[] };
    expect(pulled.records.find((record) => record.id === made.id)).toMatchObject({
      top: "team",
      title: "Dentist",
      body: "Tuesday.",
      sealed: null,
    });
  }, 30_000);
});
