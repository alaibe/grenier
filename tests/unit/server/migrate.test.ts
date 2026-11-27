import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN, startWorker } from "../../support/worker.ts";

/** A team store as it was before drizzle's migrations: its schema steps counted in `meta`, and a member. */
const OLD_STORE = `
import { DurableObject } from "cloudflare:workers";
export class TeamStore extends DurableObject {
  async fetch() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("INSERT INTO meta (key, value) VALUES ('schema', '10'), ('version', '7')");
    sql.exec("CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER)");
    sql.exec("INSERT INTO members (id, name, role, created_at) VALUES ('m1', 'ada', 'admin', 1)");
    return new Response("old");
  }
}
export default { fetch: (request, env) => env.TEAM.get(env.TEAM.idFromName("team")).fetch(request) };
`;

let persist: string;

beforeEach(async () => {
  persist = await mkdtemp(join(tmpdir(), "grenier-team-store-"));
});

afterEach(async () => {
  await rm(persist, { recursive: true, force: true });
});

const setUp = (call: Awaited<ReturnType<typeof startWorker>>["call"]) =>
  call("/api/setup", SETUP_TOKEN, { body: { member: "ada", device: "ada-mbp" } });

describe("the team store's migrations", () => {
  it("make a fresh store, and run once: a restart keeps what it holds", async () => {
    const first = await startWorker({ persist });
    expect((await setUp(first.call)).status).toBe(201);
    const pushed = await first.call("/api/changes", SETUP_TOKEN, {
      body: {
        changes: [
          {
            id: "c1",
            recordId: "r1",
            baseVersion: 0,
            changed: ["top", "title"],
            record: { top: "team", title: "Hello" },
          },
        ],
      },
    });
    expect(await pushed.json()).toMatchObject({ applied: [{ id: "c1", version: 1 }] });
    await first.mf.dispose();

    const again = await startWorker({ persist });
    expect((await setUp(again.call)).status).toBe(409);
    expect(await (await again.call("/api/me", SETUP_TOKEN)).json()).toMatchObject({ name: "ada", version: 1 });
    expect(await (await again.call("/api/records?q=hello", SETUP_TOKEN)).json()).toMatchObject({
      records: [{ id: "r1", title: "Hello" }],
    });
    await again.mf.dispose();
  }, 60_000);

  it("start a store from before them empty, so the team sets it up and pushes its pages again", async () => {
    const old = await startWorker({ persist, script: OLD_STORE });
    expect(await (await old.call("/")).text()).toBe("old");
    await old.mf.dispose();

    const store = await startWorker({ persist });
    expect((await setUp(store.call)).status).toBe(201);
    expect(await (await store.call("/api/me", SETUP_TOKEN)).json()).toMatchObject({ name: "ada", version: 0 });
    await store.mf.dispose();
  }, 60_000);
});
