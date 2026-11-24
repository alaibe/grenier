import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newVaultKey } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import { remember } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineRoutes } from "../../../apps/cli/src/connect.ts";
import { storeDeps } from "../../support/repo.ts";

let store: Store;
let home: string;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-connect-"));
  mkdirSync(join(home, ".grenier"));
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

interface Apps {
  apps: { app: string; label: string; connected: boolean }[];
}

let rounds: number;

/** The routes, and the body of a route's answer. */
function routes() {
  rounds = 0;
  const where = {
    home,
    platform: "darwin" as const,
    env: { GRENIER_HOME: join(home, ".grenier") },
    self: ["/Applications/Grenier.app/Contents/MacOS/grenier-node", "/app/grenier.js"],
  };
  const route = machineRoutes(store, resolvePaths({ GRENIER_HOME: join(home, ".grenier") }), where, async (between) => {
    await between();
    rounds += 1;
  });
  const body = async <T>(method: string, path: string, input?: unknown): Promise<T> => {
    const reply = await route(method, path, input);
    if (!reply) throw new Error(`nothing answers ${method} ${path}`);
    return reply.body as T;
  };
  return { route, body };
}

describe("adding Grenier to an app on this computer", () => {
  it("writes its MCP server with a token of its own, keeps the rest of the config, and says it is there", async () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "dark" }));
    const { route, body } = routes();
    expect((await body<Apps>("GET", "/apps")).apps).toContainEqual({
      app: "claude-code",
      label: "Claude Code",
      connected: false,
    });
    expect(await route("POST", "/apps/claude-code", { scopes: ["*"] })).toMatchObject({ status: 200 });
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.grenier).toMatchObject({
      type: "stdio",
      command: "/Applications/Grenier.app/Contents/MacOS/grenier-node",
      args: ["/app/grenier.js", "mcp", "serve"],
      env: { GRENIER_HOME: join(home, ".grenier") },
    });
    expect(config.mcpServers.grenier.env.GRENIER_CLIENT_TOKEN).toMatch(/^gc_/);
    expect((await store.clients.list()).map((client) => client.name)).toContain("claude-code");
    const apps = (await body<Apps>("GET", "/apps")).apps;
    expect(apps.find((entry) => entry.app === "claude-code")?.connected).toBe(true);
    expect((await route("POST", "/apps/vim", {}))?.status).toBe(404);
  });
});

describe("the personal key for the Me folder", () => {
  it("is made once and shown when asked, and another machine's replaces it: Me goes out again sealed with it", async () => {
    const { route, body } = routes();
    const shown = (await body<{ key: string }>("POST", "/key")).key;
    expect((await body<{ key: string }>("POST", "/key")).key).toBe(shown);
    expect((await route("PUT", "/key", { key: "not-a-key" }))?.status).toBe(400);
    expect(await route("PUT", "/key", { key: shown })).toEqual({ status: 200, body: { saved: true, unopened: 0 } });
    expect(rounds).toBe(0);

    const deps = await storeDeps(store);
    const mine = await remember(deps, null, null, { kind: "fact", title: "Dentist on Tuesday", top: "me" });
    await store.outbox.remove((await store.outbox.list()).map((entry) => entry.id));
    await store.state.set("team_cursor", "42");
    await store.state.set("team_unopened", JSON.stringify(["sealed-elsewhere"]));
    expect(await body("GET", "/key")).toEqual({ unopened: 1 });

    const other = newVaultKey();
    expect(await route("PUT", "/key", { key: other })).toEqual({ status: 200, body: { saved: true, unopened: 0 } });
    expect(readFileSync(join(home, ".grenier", "personal.key"), "utf8").trim()).toBe(other);
    expect((await store.outbox.list()).map((entry) => entry.recordId)).toEqual([mine.id]);
    expect(await store.state.get("team_cursor")).toBe("0");
    expect(rounds).toBe(1);
  });
});
