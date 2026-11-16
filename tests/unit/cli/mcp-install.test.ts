import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, install, withCodexServer } from "../../../apps/cli/src/commands/mcp.ts";
import type { Io } from "../../../apps/cli/src/io.ts";

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "grenier-install-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

let io: Io;
let expected: { command: string; args: string[]; env: Record<string, unknown> };

beforeEach(() => {
  io = {
    env: { GRENIER_HOME: join(home, ".grenier") },
    cwd: "/work",
    out: () => {},
    err: () => {},
    self: ["/usr/local/bin/node", "/opt/grenier/grenier.js"],
  };
  expected = {
    command: "/usr/local/bin/node",
    args: ["/opt/grenier/grenier.js", "mcp", "serve"],
    env: { GRENIER_CLIENT_TOKEN: expect.stringMatching(/^gc_[\w-]{43}$/), GRENIER_HOME: join(home, ".grenier") },
  };
});

describe("grenier mcp install", () => {
  it("adds the server to Claude Code's user config, keeping everything else", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }),
    );
    expect(await install(["claude-code"], io, { home })).toContain(join(home, ".claude.json"));
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.grenier).toEqual({ type: "stdio", ...expected });
  });

  it("writes Cursor's mcp.json, creating it", async () => {
    await install(["cursor"], io, { home });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"))).toEqual({
      mcpServers: { grenier: expected },
    });
  });

  it("writes Claude Desktop's config where each system keeps it", async () => {
    await install(["claude-desktop"], io, { home, platform: "darwin" });
    const mac = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    expect(JSON.parse(readFileSync(mac, "utf8")).mcpServers.grenier).toEqual(expected);
    expect(configPath("claude-desktop", home, "linux", {})).toBe(
      join(home, ".config", "Claude", "claude_desktop_config.json"),
    );
    expect(configPath("claude-desktop", home, "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toBe(
      join("C:\\Users\\a\\AppData\\Roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("adds a table to Codex's config.toml, keeping its other settings and comments", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '# my settings\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    await install(["codex"], io, { home });
    const text = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(text.startsWith('# my settings\nmodel = "o5"\n')).toBe(true);
    const config = parse(text) as { model: string; mcp_servers: Record<string, unknown> };
    expect(config.model).toBe("o5");
    expect(config.mcp_servers.other).toEqual({ command: "x" });
    expect(config.mcp_servers.grenier).toEqual(expected);
  });

  it("replaces its own Codex table when installed again", () => {
    const once = withCodexServer(
      '[mcp_servers.grenier]\ncommand = "old"\nargs = []\n\n[other]\na = 1\n',
      "node",
      ["g.js"],
      {},
    );
    const config = parse(once) as { mcp_servers: { grenier: unknown }; other: unknown };
    expect(config.mcp_servers.grenier).toEqual({ command: "node", args: ["g.js"] });
    expect(config.other).toEqual({ a: 1 });
    expect(withCodexServer(once, "node", ["g.js"], {})).toBe(once);
  });

  it("refuses an unknown client, and a config that is not JSON", async () => {
    await expect(install(["vim"], io, { home })).rejects.toThrow(
      "mcp install takes one of: claude-code, cursor, codex, claude-desktop",
    );
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not json");
    await expect(install(["cursor"], io, { home })).rejects.toThrow("not valid JSON");
  });
});

describe("client tokens from grenier mcp install", () => {
  it("gives each app a token with the scope asked for, and a new one replaces the old", async () => {
    const { openSqliteStore } = await import("@grenier/store/sqlite");
    await install(["claude-desktop", "--scope", "notes,calendar"], io, { home, platform: "linux" });
    const config = JSON.parse(readFileSync(join(home, ".config", "Claude", "claude_desktop_config.json"), "utf8"));
    const first = config.mcpServers.grenier.env.GRENIER_CLIENT_TOKEN;
    await install(["claude-desktop"], io, { home, platform: "linux" });

    const store = openSqliteStore(join(home, ".grenier", "grenier.db"));
    try {
      const clients = await store.clients.list();
      expect(
        clients.filter((client) => client.revokedAt === null).map((client) => [client.name, client.scopes]),
      ).toEqual([["claude-desktop", []]]);
      expect(clients.filter((client) => client.revokedAt !== null).map((client) => client.scopes)).toEqual([
        ["notes", "calendar"],
      ]);
      const { createHash } = await import("node:crypto");
      expect(await store.clients.findActive(createHash("sha256").update(first).digest("hex"))).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("refuses a scope that names nothing", async () => {
    await expect(install(["cursor", "--scope", "secrets"], io, { home })).rejects.toThrow("unknown scope secrets");
  });
});
