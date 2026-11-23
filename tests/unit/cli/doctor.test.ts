import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../../../apps/cli/src/commands/doctor.ts";
import { install } from "../../../apps/cli/src/commands/mcp.ts";
import type { Io } from "../../../apps/cli/src/io.ts";

let home: string;
let io: Io;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "grenier-doctor-")));
  mkdirSync(join(home, ".grenier"));
  writeFileSync(join(home, ".grenier", "config.toml"), '[proxy]\nport = 7797\n\n[store]\nembeddings = "off"\n');
  io = {
    env: { GRENIER_HOME: join(home, ".grenier"), PATH: process.env.PATH },
    cwd: home,
    out: () => {},
    err: () => {},
    self: [process.execPath, "/opt/grenier/grenier.js"],
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const line = (lines: string[], text: string) => lines.find((entry) => entry.includes(text));

describe("grenier doctor", () => {
  it("says what is missing on a fresh machine, without calling it broken", async () => {
    const { lines, code } = await doctor(io, { home, platform: "linux" });
    expect(code).toBe(0);
    expect(line(lines, "daemon")).toBe("warn  daemon is not running: grenier start (grenier run starts it too)");
    expect(line(lines, "MCP server")).toBe(
      "warn  no AI tool has Grenier's MCP server: grenier mcp install claude-code",
    );
    expect(line(lines, "embeddings")).toMatch(/^info {2}embeddings are off/);
  });

  it("passes an installed client, and fails one whose program is gone or whose token was revoked", async () => {
    await install(["claude-code"], io, { home });
    expect(line((await doctor(io, { home })).lines, "claude-code")).toMatch(/^ok {4}claude-code: MCP server installed/);

    const store = openSqliteStore(join(home, ".grenier", "grenier.db"));
    await store.clients.revoke("claude-code", Date.now());
    await store.close();
    const revoked = await doctor(io, { home });
    expect(revoked.code).toBe(1);
    expect(line(revoked.lines, "claude-code")).toBe(
      "fail  claude-code: its client token is revoked or unknown here: grenier mcp install claude-code",
    );

    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    config.mcpServers.grenier.command = "/opt/homebrew/Cellar/node/1.0.0/bin/node";
    writeFileSync(join(home, ".claude.json"), JSON.stringify(config));
    expect(line((await doctor(io, { home })).lines, "claude-code")).toBe(
      "fail  claude-code: launches /opt/homebrew/Cellar/node/1.0.0/bin/node, which is gone: grenier mcp install claude-code",
    );
  });

  it("fails a prompt hook whose program is gone", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ command: "GRENIER_HOME=/x /gone/node /grenier.js hook prompt" }] }] },
      }),
    );
    const { lines, code } = await doctor(io, { home });
    expect(code).toBe(1);
    expect(line(lines, "prompt hook")).toBe(
      "fail  Claude Code's prompt hook runs /gone/node, which is gone: grenier mcp install claude-code --hook",
    );
  });

  it("names the models seen without a price", async () => {
    const store = openSqliteStore(join(home, ".grenier", "grenier.db"));
    await store.usage.add({ sessionId: "s", ts: Date.now(), model: "gpt-9", cost: null });
    await store.usage.add({ sessionId: "s", ts: Date.now(), model: "claude-opus-5-5", cost: 1 });
    await store.close();
    expect(line((await doctor(io, { home })).lines, "no price")).toMatch(/^warn {2}no price for gpt-9: /);
  });

  it("fails a config it cannot read, saying why", async () => {
    writeFileSync(join(home, ".grenier", "config.toml"), "[proxy]\nport = 0\n");
    const { lines, code } = await doctor(io, { home });
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^fail {2}config: .*proxy\.port/s);
  });
});
