import { joinCode, newVaultKey, sha256 } from "@grenier/core";
import { recall, remember, type StoreDeps, syncOnce, type TeamClient } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeDeps } from "../../support/repo.ts";
import { hash, SETUP_TOKEN, startWorker } from "../../support/worker.ts";

let mf: Miniflare;
let workerFetch: typeof fetch;
let laptop: Store;
let desktop: Store;
let bobStore: Store;
const PERSON = { id: "p", name: "p", scopes: ["*"] };
const KEY = newVaultKey();

async function device(store: Store, _token: string, member: string, meSpace: string): Promise<StoreDeps> {
  await store.state.set("team_member", member);
  await store.state.set("team_me_space", meSpace);
  return storeDeps(store, null, { member, device: `${member}-${Math.random().toString(36).slice(2, 6)}` });
}

let ada: TeamClient;
let adaDesktop: TeamClient;
let bob: TeamClient;

async function joinAs(name: string, deviceName: string): Promise<TeamClient> {
  const call = (path: string, init: RequestInit = {}) =>
    workerFetch(`https://team.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
    });
  const invite = (await (await call("/api/invites", { method: "POST", body: JSON.stringify({ name }) })).json()) as {
    id: string;
    secret: string;
  };
  const token = `gt_${deviceName}_token_0123456789abcdef0123456789abcdef`;
  const nonce = "d".repeat(32);
  await workerFetch("https://team.test/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      invite: invite.id,
      secret: invite.secret,
      device: deviceName,
      tokenHash: hash(token),
      nonce,
    }),
  });
  const code = await joinCode(await sha256(invite.secret), nonce);
  await call("/api/invites/confirm", { method: "POST", body: JSON.stringify({ code }) });
  return { url: "https://team.test", token, fetch: workerFetch };
}

beforeEach(async () => {
  ({ mf, fetch: workerFetch } = await startWorker());
  await workerFetch("https://team.test/api/setup", {
    method: "POST",
    headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ member: "ada", device: "ada-laptop" }),
  });
  ada = { url: "https://team.test", token: SETUP_TOKEN, fetch: workerFetch };
  adaDesktop = await joinAs("ada", "ada-desktop");
  bob = await joinAs("bob", "bob-mbp");
  laptop = openSqliteStore(":memory:");
  desktop = openSqliteStore(":memory:");
  bobStore = openSqliteStore(":memory:");
}, 60_000);

afterEach(async () => {
  await Promise.all([laptop.close(), desktop.close(), bobStore.close()]);
  await mf.dispose();
});

async function meSpace(team: TeamClient): Promise<string> {
  const response = await workerFetch(`${team.url}/api/me`, { headers: { authorization: `Bearer ${team.token}` } });
  return ((await response.json()) as { me: string }).me;
}

describe("sync between machines", () => {
  it("brings a teammate's team record to another machine, and keeps a me record sealed to its person", async () => {
    const adaDeps = await device(laptop, ada.token, "ada", await meSpace(ada));
    await laptop.spaces.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
    await remember(adaDeps, PERSON, null, { kind: "convention", title: "Squash merges only", space: "team" });
    await remember(adaDeps, PERSON, null, { kind: "fact", title: "My dentist is on Tuesday", space: "me" });
    const pushed = await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    expect(pushed.pushed).toBe(2);
    expect(await laptop.outbox.list()).toEqual([]);

    const bobDeps = await device(bobStore, bob.token, "bob", await meSpace(bob));
    const pulled = await syncOnce({ store: bobStore, team: bob, embedder: null, personalKey: null });
    expect(pulled.pulled).toBe(1);
    expect((await recall(bobDeps, PERSON, { query: "squash merges", repo: null })).results[0]?.author).toBe("ada");

    const deskDeps = await device(desktop, adaDesktop.token, "ada", await meSpace(adaDesktop));
    await syncOnce({ store: desktop, team: adaDesktop, embedder: null, personalKey: KEY });
    const mine = await recall(deskDeps, PERSON, { query: "dentist Tuesday", repo: null });
    expect(mine.results[0]).toMatchObject({ space: "me", title: "My dentist is on Tuesday" });

    const stored = await workerFetch("https://team.test/api/changes?after=0", {
      headers: { authorization: `Bearer ${ada.token}` },
    });
    const text = await stored.text();
    expect(text).not.toContain("dentist");
  });

  it("leaves a me record on the machine without the key, and says so", async () => {
    const adaDeps = await device(laptop, ada.token, "ada", await meSpace(ada));
    await remember(adaDeps, PERSON, null, { kind: "fact", title: "Private", space: "me" });
    await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    await device(desktop, adaDesktop.token, "ada", await meSpace(adaDesktop));
    const result = await syncOnce({ store: desktop, team: adaDesktop, embedder: null, personalKey: newVaultKey() });
    expect(result.unopened).toBe(1);
    expect(await desktop.records.list({ spaces: ["me"] })).toEqual([]);
  });

  it("keeps changes made offline and sends them at the next round", async () => {
    const adaDeps = await device(laptop, ada.token, "ada", await meSpace(ada));
    await laptop.spaces.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
    const offline: TeamClient = {
      ...ada,
      fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    };
    await remember(adaDeps, PERSON, null, { kind: "fact", title: "Written on a train", space: "team" });
    await expect(syncOnce({ store: laptop, team: offline, embedder: null, personalKey: KEY })).rejects.toThrow(
      "offline",
    );
    expect(await laptop.outbox.list()).toHaveLength(1);
    expect((await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY })).pushed).toBe(1);
    const record = (await laptop.records.list({ spaces: ["team"] }))[0];
    expect(record?.version).toBeGreaterThan(0);
  });

  it("keeps a change the team store refuses here, with why, and sends the others", async () => {
    const adaDeps = await device(laptop, ada.token, "ada", await meSpace(ada));
    await laptop.spaces.put({ id: "space:gone", name: "gone", kind: "custom", repoId: null, root: null });
    await laptop.spaces.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
    await remember(adaDeps, PERSON, null, { kind: "fact", title: "Nowhere", space: "space:gone" });
    await remember(adaDeps, PERSON, null, { kind: "fact", title: "Somewhere", space: "team" });
    const result = await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    expect(result.pushed).toBe(1);
    expect(result.refused[0]?.reason).toContain("no space space:gone");
    expect((await laptop.outbox.list())[0]?.refused).toContain("no space");
  });
});
