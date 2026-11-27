import { joinCode, newVaultKey, sha256 } from "@grenier/core";
import { recall, rekeyed, remember, type StoreDeps, syncOnce, type TeamClient, unopenedCount } from "@grenier/index";
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

async function device(store: Store, member: string, meTop: string): Promise<StoreDeps> {
  await store.state.set("team_member", member);
  await store.state.set("team_me_top", meTop);
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

async function meTop(team: TeamClient): Promise<string> {
  const response = await workerFetch(`${team.url}/api/me`, { headers: { authorization: `Bearer ${team.token}` } });
  return ((await response.json()) as { me: string }).me;
}

describe("sync between machines", () => {
  it("brings a teammate's team record to another machine, and keeps a me record sealed to its person", async () => {
    const adaDeps = await device(laptop, "ada", await meTop(ada));
    await laptop.state.set("team_member", "ada");
    await remember(adaDeps, PERSON, null, {
      title: "Squash merges only",
      folder: "Engineering/Git",
      top: "team",
    });
    await remember(adaDeps, PERSON, null, {
      title: "My dentist is on Tuesday",
      folder: "Health/Appointments",
      top: "me",
    });
    const pushed = await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    expect(pushed.pushed).toBe(2);
    expect(await laptop.outbox.list()).toEqual([]);

    const bobDeps = await device(bobStore, "bob", await meTop(bob));
    const pulled = await syncOnce({ store: bobStore, team: bob, embedder: null, personalKey: null });
    expect(pulled.pulled).toBe(1);
    expect((await recall(bobDeps, PERSON, { query: "squash merges", repo: null })).results[0]?.author).toBe("ada");
    expect((await bobStore.records.list({ tops: ["team"] }))[0]?.folder).toBe("Engineering/Git");

    const deskDeps = await device(desktop, "ada", await meTop(adaDesktop));
    await syncOnce({ store: desktop, team: adaDesktop, embedder: null, personalKey: KEY });
    const mine = await recall(deskDeps, PERSON, { query: "dentist Tuesday", repo: null });
    expect(mine.results[0]).toMatchObject({ top: "me", title: "My dentist is on Tuesday" });
    expect((await desktop.records.get(mine.results[0]?.id as string))?.folder).toBe("Health/Appointments");

    const stored = await workerFetch("https://team.test/api/changes?after=0", {
      headers: { authorization: `Bearer ${ada.token}` },
    });
    const text = await stored.text();
    expect(text).not.toContain("dentist");
    expect(text).not.toContain("Health");
  });

  it("shares a me record moved to the team in the clear", async () => {
    const adaDeps = await device(laptop, "ada", await meTop(ada));
    await laptop.state.set("team_member", "ada");
    const kept = await remember(adaDeps, PERSON, null, { title: "Standup moves to ten", top: "me" });
    await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    await remember(adaDeps, PERSON, null, { id: kept.id, title: "Standup moves to ten", top: "team" });
    await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });

    const bobDeps = await device(bobStore, "bob", await meTop(bob));
    await syncOnce({ store: bobStore, team: bob, embedder: null, personalKey: null });
    const found = await recall(bobDeps, PERSON, { query: "standup ten", repo: null });
    expect(found.results[0]).toMatchObject({ top: "team", title: "Standup moves to ten" });
  });

  it("leaves a me record on the machine without the key, and says so", async () => {
    const adaDeps = await device(laptop, "ada", await meTop(ada));
    await remember(adaDeps, PERSON, null, { title: "Private", top: "me" });
    await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    await device(desktop, "ada", await meTop(adaDesktop));
    const result = await syncOnce({ store: desktop, team: adaDesktop, embedder: null, personalKey: newVaultKey() });
    expect(result.unopened).toBe(1);
    expect(await desktop.records.list({ tops: ["me"] })).toEqual([]);
  });

  it("remembers the Me pages it cannot open across rounds, and opens them once the other machine's key is used here", async () => {
    const adaDeps = await device(laptop, "ada", await meTop(ada));
    await remember(adaDeps, PERSON, null, { title: "Written on the laptop", top: "me" });
    await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });

    const joinedWith = newVaultKey();
    const deskDeps = await device(desktop, "ada", await meTop(adaDesktop));
    await remember(deskDeps, PERSON, null, { title: "Written on the desktop", top: "me" });
    await syncOnce({ store: desktop, team: adaDesktop, embedder: null, personalKey: joinedWith });
    expect(await unopenedCount(desktop)).toBe(1);
    await syncOnce({ store: desktop, team: adaDesktop, embedder: null, personalKey: joinedWith });
    expect(await unopenedCount(desktop)).toBe(1);

    await rekeyed(desktop);
    await syncOnce({ store: desktop, team: adaDesktop, embedder: null, personalKey: KEY });
    expect(await unopenedCount(desktop)).toBe(0);
    const both = ["Written on the desktop", "Written on the laptop"];
    expect((await desktop.records.list({ tops: ["me"] })).map((record) => record.title).sort()).toEqual(both);

    const laptopRound = await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    expect(laptopRound.unopened).toBe(0);
    expect((await laptop.records.list({ tops: ["me"] })).map((record) => record.title).sort()).toEqual(both);
  });

  it("keeps changes made offline and sends them at the next round", async () => {
    const adaDeps = await device(laptop, "ada", await meTop(ada));
    await laptop.state.set("team_member", "ada");
    const offline: TeamClient = {
      ...ada,
      fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    };
    await remember(adaDeps, PERSON, null, { title: "Written on a train", top: "team" });
    await expect(syncOnce({ store: laptop, team: offline, embedder: null, personalKey: KEY })).rejects.toThrow(
      "offline",
    );
    expect(await laptop.outbox.list()).toHaveLength(1);
    expect((await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY })).pushed).toBe(1);
    const record = (await laptop.records.list({ tops: ["team"] }))[0];
    expect(record?.version).toBeGreaterThan(0);
  });

  it("waits for a team store older than this Grenier to be deployed again, and sends nothing to it", async () => {
    const adaDeps = await device(laptop, "ada", await meTop(ada));
    await laptop.state.set("team_member", "ada");
    await remember(adaDeps, PERSON, null, { title: "Squash merges only", top: "team" });
    const older: TeamClient = {
      ...ada,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await workerFetch(input, init);
        if (!String(input).endsWith("/api/me")) return response;
        const { protocol: _protocol, ...me } = (await response.json()) as Record<string, unknown>;
        return Response.json(me);
      }) as typeof fetch,
    };
    await expect(syncOnce({ store: laptop, team: older, embedder: null, personalKey: KEY })).rejects.toThrow(
      "update it on the app's Team screen",
    );
    expect(await laptop.outbox.list()).toHaveLength(1);
    expect(await laptop.state.get("team_protocol")).toBe("1");
  });

  it("never sends a change that names no top folder: it could be a me record", async () => {
    await device(laptop, "ada", await meTop(ada));
    await laptop.outbox.add({
      id: "o1",
      recordId: "m1",
      change: {
        changed: ["title", "body"],
        record: { id: "m1", type: "Doc", title: "My dentist", body: "Tuesday" },
      },
      baseVersion: 0,
      createdAt: 1,
    });
    expect((await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY })).pushed).toBe(0);
    expect(await laptop.outbox.list()).toHaveLength(1);
    const stored = await workerFetch("https://team.test/api/changes?after=0", {
      headers: { authorization: `Bearer ${ada.token}` },
    });
    expect(await stored.text()).not.toContain("dentist");
  });

  it("drops a change the team store refuses, says why, and sends the others", async () => {
    const adaDeps = await device(laptop, "ada", await meTop(ada));
    await laptop.state.set("team_member", "ada");
    const sent = await remember(adaDeps, PERSON, null, { title: "Somewhere", top: "team" });
    const refusedOne = await remember(adaDeps, PERSON, null, { title: "Elsewhere", top: "team" });
    const [entry] = (await laptop.outbox.list()).filter((change) => change.recordId === refusedOne.id);
    // A top folder the team store does not have, as a stale outbox from an older Grenier would carry.
    await laptop.outbox.remove([entry?.id as string]);
    await laptop.outbox.add({
      ...(entry as NonNullable<typeof entry>),
      change: { changed: ["top", "title"], record: { id: refusedOne.id, top: "top:gone", title: "Elsewhere" } },
    });
    const result = await syncOnce({ store: laptop, team: ada, embedder: null, personalKey: KEY });
    expect(result.pushed).toBe(1);
    expect(result.refused[0]?.reason).toContain("no top folder top:gone");
    expect(sent.id).toBeDefined();
    expect(await laptop.outbox.list()).toEqual([]);
  });
});
