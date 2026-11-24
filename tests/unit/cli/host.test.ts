import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grenier/core";
import { ensureDirectories, resolvePaths } from "@grenier/core/node";
import { remember, type TeamClient } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorDiffs, joining } from "../../../apps/cli/src/host.ts";
import { storeDeps, TestRepo } from "../../support/repo.ts";
import { SETUP_TOKEN, startWorker } from "../../support/worker.ts";

let store: Store;
let home: string;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-host-"));
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
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
    const paths = resolvePaths({ GRENIER_HOME: home });
    ensureDirectories(paths);
    const started: TeamClient[] = [];
    const route = joining({
      paths,
      config: { ...defaultConfig(), machine: { ...defaultConfig().machine, name: "bob-mbp" } },
      store,
      fetch: workerFetch,
      joined: (team) => started.push(team),
    });

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
    expect(existsSync(join(home, "team-token"))).toBe(true);
    expect(await store.state.get("team_member")).toBe("bob");
  }, 30_000);

  it("refuses what is not an invite link", async () => {
    const paths = resolvePaths({ GRENIER_HOME: home });
    const route = joining({ paths, config: defaultConfig(), store, fetch: workerFetch, joined: () => {} });
    expect(await route("POST", "/join", { link: "https://example.com" })).toMatchObject({ status: 400 });
    expect(await route("GET", "/join", undefined)).toEqual({ status: 200, body: { state: "idle" } });
    expect(await route("GET", "/elsewhere", undefined)).toBeNull();
  });
});

describe("the change to a file a record was written from", () => {
  it("shows the version it was written from and the one there is now", async () => {
    const repo = new TestRepo({ "router.ts": "export function route() {}\n" });
    try {
      await repo.ready();
      const deps = await storeDeps(store);
      const kept = await remember(deps, { id: "c", name: "claude", scopes: ["*"] }, repo.repo, {
        kind: "answer",
        title: "Where are requests routed?",
        body: "route() in router.ts.",
        files: ["router.ts"],
        top: "me",
      });
      repo.write("router.ts", "export function route(path: string) {}\n");
      const diff = await anchorDiffs(store)("GET", `/records/${kept.id}/diff?path=router.ts`, undefined);
      expect(diff).toEqual({
        status: 200,
        body: {
          path: "router.ts",
          before: "export function route() {}\n",
          now: "export function route(path: string) {}\n",
        },
      });
      expect((await anchorDiffs(store)("GET", `/records/${kept.id}/diff?path=other.ts`, undefined))?.status).toBe(404);
    } finally {
      repo.remove();
    }
  });
});
