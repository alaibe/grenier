import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newVaultKey } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineRoutes } from "../../../apps/cli/src/connect.ts";

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

/** The routes, and the body of a route's answer. */
function routes() {
  const route = machineRoutes(store, resolvePaths({ GRENIER_HOME: join(home, ".grenier") }), {
    home,
    platform: "darwin",
    env: { GRENIER_HOME: join(home, ".grenier") },
    self: ["/Applications/Grenier.app/Contents/MacOS/grenier-node", "/app/grenier.js"],
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
  it("is made once and shown when asked, and another machine's is taken only where none is", async () => {
    const { route, body } = routes();
    const shown = (await body<{ key: string }>("POST", "/key")).key;
    expect((await body<{ key: string }>("POST", "/key")).key).toBe(shown);
    expect((await route("PUT", "/key", { key: "not-a-key" }))?.status).toBe(400);
    expect((await route("PUT", "/key", { key: newVaultKey() }))?.status).toBe(409);
    expect(await route("PUT", "/key", { key: shown })).toEqual({ status: 200, body: { saved: true } });
  });
});
