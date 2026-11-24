import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import type { TeamClient } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testAdmin } from "../../../support/gateway.ts";
import { SETUP_TOKEN, startWorker } from "../../../support/worker.ts";

let store: Store;
let home: string;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-team-"));
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the team store's pages", () => {
  let team: TeamClient | null;
  const call = (path: string) => testAdmin(store, home, { team: () => team }).call(path);

  beforeEach(() => {
    team = null;
  });

  it("passes the team's pages through with this device's token, and says when there is no team", async () => {
    expect((await call("/team/members")).status).toBe(409);
    team = {
      url: "https://team.test",
      token: "gt_x",
      fetch: (async (url: URL) => Response.json({ path: url.pathname })) as unknown as typeof fetch,
    };
    expect(await (await call("/team/members")).json()).toEqual({ path: "/api/members" });
  });

  it("says the team store can't be reached when this machine is offline", async () => {
    team = {
      url: "https://team.test",
      token: "gt_x",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    };
    const offline = await call("/team/members");
    expect(offline.status).toBe(502);
    expect(await offline.json()).toEqual({ error: "the team store can't be reached" });
  });
});

describe("joining a team from the app", () => {
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

  it("shows the code the admin confirms, then saves the team and starts the link", async () => {
    const admin = { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" };
    const invite = (await (
      await workerFetch("https://team.test/api/invites", {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "bob" }),
      })
    ).json()) as { id: string; secret: string };
    const paths = resolvePaths({ GRENIER_HOME: join(home, ".grenier") });
    const started: TeamClient[] = [];
    const route = testAdmin(store, home, {
      config: () => ({ ...defaultConfig(), machine: { ...defaultConfig().machine, name: "bob-mbp" } }),
      fetch: workerFetch,
      joined: (team) => started.push(team),
    }).reply;

    const asked = await route("POST", "/join", { link: `grenier://join/team.test/${invite.id}/${invite.secret}` });
    expect(asked?.status).toBe(202);
    const code = (asked?.body as { code?: string } | undefined)?.code;
    expect(code).toMatch(/^\d{6}$/);
    expect((await route("POST", "/join", { link: "x" }))?.status).toBe(409);

    const confirmed = await workerFetch("https://team.test/api/invites/confirm", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ code }),
    });
    expect(await confirmed.json()).toEqual({ joined: "bob", device: "bob-mbp" });

    const deadline = Date.now() + 10_000;
    let state = (await route("GET", "/join", undefined))?.body as { state: string };
    while (state.state === "waiting" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      state = (await route("GET", "/join", undefined))?.body as { state: string };
    }
    expect(state).toMatchObject({ state: "joined", member: "bob" });
    expect(started).toHaveLength(1);
    expect(readFileSync(paths.config, "utf8")).toContain('url = "https://team.test"');
    expect(existsSync(paths.teamToken)).toBe(true);
    expect(await store.state.get("team_member")).toBe("bob");
  }, 30_000);

  it("joins under the name this machine was given in Settings since the daemon started", async () => {
    const admin = { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" };
    const invite = (await (
      await workerFetch("https://team.test/api/invites", {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "bob" }),
      })
    ).json()) as { id: string; secret: string };
    const route = testAdmin(store, home, { fetch: workerFetch }).reply;
    expect(await route("PUT", "/machine", { rules: { name: "bob-studio" } })).toMatchObject({ status: 200 });

    const asked = await route("POST", "/join", { link: `grenier://join/team.test/${invite.id}/${invite.secret}` });
    const confirmed = await workerFetch("https://team.test/api/invites/confirm", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ code: (asked.body as { code?: string }).code }),
    });
    expect(await confirmed.json()).toEqual({ joined: "bob", device: "bob-studio" });
    const deadline = Date.now() + 10_000;
    while (((await route("GET", "/join", undefined)).body as { state: string }).state === "waiting") {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 30_000);

  it("refuses what is not an invite link", async () => {
    const route = testAdmin(store, home, { fetch: workerFetch }).reply;
    expect(await route("POST", "/join", { link: "https://example.com" })).toMatchObject({ status: 400 });
    expect(await route("GET", "/join", undefined)).toEqual({ status: 200, body: { state: "idle" } });
    expect(await route("GET", "/elsewhere", undefined)).toEqual({ status: 404, body: { error: "no GET /elsewhere" } });
  });
});

describe("deploying the team store from the app", () => {
  it("sets it up under the name this machine was given in Settings since the daemon started", async () => {
    const serverDir = join(home, "server");
    mkdirSync(serverDir);
    writeFileSync(join(serverDir, "server.js"), "export default {};");
    let device: unknown = null;
    const cloudflare = (async (input: string | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/setup") {
        device = (JSON.parse(String(init.body)) as { device?: unknown }).device;
        return Response.json({ member: "ada" }, { status: 201 });
      }
      const result = path.endsWith("/accounts")
        ? [{ id: "acc1" }]
        : path.endsWith("/workers/scripts")
          ? []
          : path.endsWith("/workers/subdomain")
            ? { subdomain: "acme" }
            : {};
      return Response.json({ success: true, result });
    }) as typeof fetch;
    const route = testAdmin(store, home, { fetch: cloudflare, serverDir }).reply;
    expect(await route("PUT", "/machine", { rules: { name: "ada-studio" } })).toMatchObject({ status: 200 });

    const deployed = await route("POST", "/deploy", { token: "cf_token", name: "grenier-team", member: "ada" });
    expect(deployed).toEqual({ status: 200, body: { url: "https://grenier-team.acme.workers.dev", created: true } });
    expect(device).toBe("ada-studio");
  });
});
