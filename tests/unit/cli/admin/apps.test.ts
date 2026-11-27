import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testAdmin } from "../../../support/gateway.ts";

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
  const where = {
    home,
    platform: "darwin" as const,
    env: { GRENIER_HOME: join(home, ".grenier") },
    self: ["/Applications/Grenier.app/Contents/MacOS/grenier-node", "/app/grenier.js"],
  };
  const route = testAdmin(store, home, { where }).reply;
  const body = async <T>(method: string, path: string, input?: unknown): Promise<T> =>
    (await route(method, path, input)).body as T;
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

describe("the client tokens", () => {
  const call = (path: string, init?: RequestInit) => testAdmin(store, home).call(path, init);

  beforeEach(async () => {
    await store.state.set("team_member", "ada");
  });

  it("creates, lists and revokes clients, with known scopes only", async () => {
    const created = await call("/clients", {
      method: "POST",
      body: JSON.stringify({ name: "claude", scopes: ["team"] }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { token: string }).token).toMatch(/^gc_/);
    expect(
      (await call("/clients", { method: "POST", body: JSON.stringify({ name: "x", scopes: ["nowhere"] }) })).status,
    ).toBe(400);
    expect(
      ((await (await call("/clients")).json()) as { clients: { name: string }[] }).clients.map((c) => c.name),
    ).toEqual(["claude"]);
    expect((await call("/clients/claude/revoke", { method: "POST" })).status).toBe(200);
    expect(((await (await call("/clients")).json()) as { clients: unknown[] }).clients).toEqual([]);
  });
});
