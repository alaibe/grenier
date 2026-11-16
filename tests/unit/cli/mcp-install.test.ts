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

const io: Io = {
  env: { GRENIER_HOME: "/data/grenier" },
  cwd: "/work",
  out: () => {},
  err: () => {},
  self: ["/usr/local/bin/node", "/opt/grenier/grenier.js"],
};

const expected = {
  command: "/usr/local/bin/node",
  args: ["/opt/grenier/grenier.js", "mcp", "serve"],
  env: { GRENIER_HOME: "/data/grenier" },
};

describe("grenier mcp install", () => {
  it("adds the server to Claude Code's user config, keeping everything else", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }),
    );
    expect(install(["claude-code"], io, { home })).toContain(join(home, ".claude.json"));
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "x" });
    expect(config.mcpServers.grenier).toEqual({ type: "stdio", ...expected });
  });

  it("writes Cursor's mcp.json, creating it", () => {
    install(["cursor"], io, { home });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"))).toEqual({
      mcpServers: { grenier: expected },
    });
  });

  it("writes Claude Desktop's config where each system keeps it", () => {
    install(["claude-desktop"], io, { home, platform: "darwin" });
    const mac = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    expect(JSON.parse(readFileSync(mac, "utf8")).mcpServers.grenier).toEqual(expected);
    expect(configPath("claude-desktop", home, "linux", {})).toBe(
      join(home, ".config", "Claude", "claude_desktop_config.json"),
    );
    expect(configPath("claude-desktop", home, "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toBe(
      join("C:\\Users\\a\\AppData\\Roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("adds a table to Codex's config.toml, keeping its other settings and comments", () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '# my settings\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    install(["codex"], io, { home });
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

  it("refuses an unknown client, and a config that is not JSON", () => {
    expect(() => install(["vim"], io, { home })).toThrow(
      "mcp install takes one of: claude-code, cursor, codex, claude-desktop",
    );
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not json");
    expect(() => install(["cursor"], io, { home })).toThrow("not valid JSON");
  });
});
