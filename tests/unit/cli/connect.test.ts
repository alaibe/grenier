import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientOf, type McpClient, type Where } from "../../../apps/cli/src/agents/index.ts";
import { readServers, writeServers } from "../../../apps/cli/src/agents/toml.ts";
import { connectApp } from "../../../apps/cli/src/connect.ts";

let home: string;
let store: Store;
let where: Where;
let expected: { command: string; args: string[]; env: Record<string, unknown> };

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "grenier-app-config-")));
  store = openSqliteStore(":memory:");
  where = {
    home,
    platform: "darwin",
    env: { GRENIER_HOME: join(home, ".grenier") },
    self: ["/usr/local/bin/node", "/opt/grenier/grenier.js"],
  };
  expected = {
    command: "/usr/local/bin/node",
    args: ["/opt/grenier/grenier.js", "mcp", "serve"],
    env: { GRENIER_CLIENT_TOKEN: expect.stringMatching(/^gc_[\w-]{43}$/), GRENIER_HOME: join(home, ".grenier") },
  };
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("adding Grenier's MCP server to an app's config", () => {
  it("keeps everything else in Claude Code's user config", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }),
    );
    expect(await connectApp(store, clientOf("claude-code") as McpClient, ["*"], where)).toBe(
      join(home, ".claude.json"),
    );
    expect(readFileSync(join(home, ".claude", "skills", "grenier-setup", "SKILL.md"), "utf8")).toContain(
      "name: grenier-setup",
    );
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.grenier).toEqual({ type: "stdio", ...expected });
  });

  it("gives Claude Code a SessionStart hook for step 1, keeping the person's own and replacing its earlier one", async () => {
    const own = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
    const old = { hooks: [{ type: "command", command: "/old/grenier mcp context" }] };
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", hooks: { SessionStart: [own, old], Stop: [own] } }),
    );
    await connectApp(store, clientOf("claude-code") as McpClient, ["*"], where);
    await connectApp(store, clientOf("claude-code") as McpClient, ["*"], where);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toEqual([own]);
    expect(settings.hooks.SessionStart).toEqual([
      own,
      {
        matcher: "startup|clear|compact",
        hooks: [
          {
            type: "command",
            command: `GRENIER_HOME=${join(home, ".grenier")} /usr/local/bin/node /opt/grenier/grenier.js mcp context`,
            timeout: 10,
          },
        ],
      },
    ]);
  });

  it("writes Cursor's mcp.json, creating it, and Claude Desktop's config where each system keeps it", async () => {
    await connectApp(store, clientOf("cursor") as McpClient, ["*"], where);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"))).toEqual({
      mcpServers: { grenier: expected },
    });
    await connectApp(store, clientOf("claude-desktop") as McpClient, ["*"], where);
    const mac = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    expect(JSON.parse(readFileSync(mac, "utf8")).mcpServers.grenier).toEqual(expected);
    const desktop = clientOf("claude-desktop");
    expect(desktop?.configPath({ home, platform: "linux", env: {}, self: [] })).toBe(
      join(home, ".config", "Claude", "claude_desktop_config.json"),
    );
    expect(
      desktop?.configPath({ home, platform: "win32", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, self: [] }),
    ).toBe(join("C:\\Users\\a\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
  });

  it("adds a table to Codex's config.toml, keeping its settings and comments, and replaces its own", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '# my settings\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    await connectApp(store, clientOf("codex") as McpClient, ["*"], where);
    const text = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(text.startsWith('# my settings\nmodel = "o5"\n')).toBe(true);
    const config = parse(text) as { model: string; mcp_servers: Record<string, unknown> };
    expect(config.mcp_servers.other).toEqual({ command: "x" });
    expect(config.mcp_servers.grenier).toEqual(expected);
    const before = '[mcp_servers.grenier]\ncommand = "old"\nargs = []\n\n[other]\na = 1\n';
    const once = writeServers(before, { ...readServers(before), grenier: { command: "node", args: ["g.js"] } });
    expect((parse(once) as { mcp_servers: { grenier: unknown }; other: unknown }).mcp_servers.grenier).toEqual({
      command: "node",
      args: ["g.js"],
    });
    expect((parse(once) as { other: unknown }).other).toEqual({ a: 1 });
    expect(writeServers(once, readServers(once))).toBe(once);
  });

  it("gives each app a token with its folders, a new one replaces the old, and a broken config keeps the old", async () => {
    await connectApp(store, clientOf("cursor") as McpClient, ["me"], where);
    const read = () =>
      JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.grenier.env.GRENIER_CLIENT_TOKEN;
    const first = read();
    await connectApp(store, clientOf("cursor") as McpClient, ["*"], where);
    const clients = await store.clients.list();
    expect(clients.filter((client) => client.revokedAt === null).map((client) => [client.name, client.scopes])).toEqual(
      [["cursor", ["*"]]],
    );
    expect(await store.clients.findActive(createHash("sha256").update(first).digest("hex"))).toBeUndefined();

    const working = read();
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not json");
    await expect(connectApp(store, clientOf("cursor") as McpClient, ["*"], where)).rejects.toThrow("not valid JSON");
    expect(await store.clients.findActive(createHash("sha256").update(working).digest("hex"))).toBeDefined();
  });
});
