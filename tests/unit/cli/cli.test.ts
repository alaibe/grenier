import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_FIRST } from "@grenier/gateway";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { version } from "../../../apps/cli/package.json";
import { run } from "../../../apps/cli/src/cli.ts";
import { agentArgs, asksFirst, run as runAgent } from "../../../apps/cli/src/commands/run.ts";
import { daemonState, infoFile, pidFile, stopDaemon } from "../../../apps/cli/src/daemon.ts";
import type { Io } from "../../../apps/cli/src/io.ts";

let dir: string;
let home: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-cli-")));
  home = join(dir, ".grenier");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io(out: string[] = [], err: string[] = []): Io {
  return {
    env: { GRENIER_HOME: home, PATH: process.env.PATH },
    cwd: dir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    self: [],
  };
}

async function grenier(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, io(out, err));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function db() {
  return openSqliteStore(join(home, "grenier.db"));
}

describe("grenier --version and help", () => {
  it("prints the version", async () => {
    expect(await grenier("--version")).toEqual({ code: 0, out: version, err: "" });
    expect((await grenier("-v")).out).toBe(version);
  });

  it("exits with 2 on an unknown command, option or argument", async () => {
    for (const argv of [["frobnicate"], ["--frobnicate"], ["status", "extra"], ["report", "--by", "week"]]) {
      const result = await grenier(...argv);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/^grenier: /);
    }
    expect((await grenier("frobnicate")).err).toContain("Usage: grenier <command>");
  });

  it("reports a path that is not a repository, without a stack trace", async () => {
    const result = await grenier("ask", "--repo", dir, "Where is the proxy?");
    expect(result).toMatchObject({ code: 1, err: `grenier: not inside a git repository: ${dir}` });
  });

  it("shows one command's help, however it is asked", async () => {
    for (const argv of [
      ["help", "mcp"],
      ["mcp", "--help"],
      ["mcp", "install", "-h"],
      ["mcp", "help"],
    ]) {
      const result = await grenier(...argv);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/^ {2}mcp install /);
      expect(result.out).toContain("mcp share <name>");
      expect(result.out).not.toContain("team deploy");
      expect(result.out).toMatch(/Every command: grenier --help$/);
    }
    expect((await grenier("help", "stop")).out).toMatch(/^ {2}start, stop /);
    expect((await grenier("help")).out).toMatch(/^Usage: grenier <command>/);
    const unknown = await grenier("help", "frobnicate");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown command "frobnicate"');
  });
});

describe("grenier status", () => {
  it("creates the home directory and the database on first run", async () => {
    const result = await grenier("status");
    expect(result.code).toBe(0);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, "grenier.db"))).toBe(true);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    expect(result.out.split("\n")).toEqual([
      `grenier ${version}`,
      `config    ${join(home, "config.toml")} (not found, using defaults)`,
      `database  ${join(home, "grenier.db")} (schema 2)`,
      "proxy     127.0.0.1:7788 → https://api.anthropic.com",
      "daemon    stopped",
    ]);
  });

  it("fails with the config error and exit code 1 on an invalid config", async () => {
    await grenier("status");
    writeFileSync(join(home, "config.toml"), "[proxy]\nport = 0\n");
    expect(await grenier("status")).toEqual({
      code: 1,
      out: "",
      err: `grenier: Invalid config in ${join(home, "config.toml")}:\n  proxy.port: Too small: expected number to be >=1`,
    });
  });
});

describe("the daemon's identity", () => {
  it("is stopped without a record, or with one naming a dead pid or garbage", async () => {
    await grenier("status");
    expect(await daemonState(home, 7799)).toEqual({ state: "stopped" });
    writeFileSync(pidFile(home), "2147483646\n");
    expect(await daemonState(home, 7799)).toEqual({ state: "stopped" });
    writeFileSync(infoFile(home), "not json");
    writeFileSync(pidFile(home), "not a pid\n");
    expect(await daemonState(home, 7799)).toEqual({ state: "stopped" });
  });

  it("never signals another program that reused the daemon's pid, and removes the stale record", async () => {
    await grenier("status");
    // Its command line names both words, as a log viewer's would: only the daemon's own ending counts.
    const stranger = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)", "/home/ada/.grenier/daemon.log", "grenier", "daemon", "--follow"],
      { stdio: "ignore" },
    );
    try {
      const pid = stranger.pid as number;
      writeFileSync(infoFile(home), JSON.stringify({ pid, port: 7799, version: "0.0.0" }));
      expect(await daemonState(home, 7799)).toEqual({ state: "stale", pid });
      expect(await stopDaemon(io())).toEqual({ pid: null, stale: pid });
      expect(stranger.exitCode).toBeNull();
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(existsSync(infoFile(home))).toBe(false);

      writeFileSync(pidFile(home), `${pid}\n`);
      const out: string[] = [];
      await run(["status"], io(out));
      expect(out.join("\n")).toContain(`daemon    stopped (its record names pid ${pid}, now another program's)`);
    } finally {
      stranger.kill();
    }
  });
});

describe("an unknown config section", () => {
  it("is refused, so a typo does not pass silently", async () => {
    await grenier("status");
    writeFileSync(join(home, "config.toml"), "[budgets]\ndaily = 10\n");
    const result = await grenier("status");
    expect(result.code).toBe(1);
    expect(result.err).toContain('Unrecognized key: "budgets"');
  });
});

describe("grenier resume", () => {
  it("lets a paused session continue and records it", async () => {
    await grenier("status");
    const store = db();
    await store.sessions.create({ id: "s1", startedAt: 0, paused: true });
    await store.close();

    expect(await grenier("resume", "s1")).toEqual({ code: 0, out: "Session s1 resumed.", err: "" });
    expect((await grenier("resume", "s1")).out).toBe("Session s1 is not paused.");

    const after = db();
    expect((await after.sessions.get("s1"))?.paused).toBe(false);
    expect((await after.events.list({ kind: "resume" })).length).toBe(1);
    await after.close();
  });
});

describe("grenier report", () => {
  it("shows the requests of the period", async () => {
    await grenier("status");
    const store = db();
    await store.sessions.create({ id: "s1", startedAt: Date.now(), repoRoot: "/work/app", repoId: "r1" });
    await store.usage.add({ sessionId: "s1", ts: Date.now(), model: "claude-opus-5-5", inputTokens: 10, cost: 0.5 });
    await store.close();

    const byRepo = await grenier("report", "--by", "repo");
    expect(byRepo.code).toBe(0);
    expect(byRepo.out).toMatch(/^app\s+1\s+10\s/m);
    expect((await grenier("report", "--since", "2000-01-01")).out).toMatch(/^total\s+1/m);
  });
});

describe("grenier statusline", () => {
  beforeEach(async () => {
    await grenier("status");
    const store = db();
    const yesterday = Date.now() - 2 * 86_400_000;
    await store.sessions.create({ id: "s1", startedAt: yesterday });
    await store.sessions.create({ id: "s2", startedAt: Date.now(), repoRoot: "/work/app", repoId: "r1" });
    await store.usage.add({ sessionId: "s1", ts: yesterday, model: "claude-opus-5-5", cost: 4 });
    await store.usage.add({ sessionId: "s1", ts: Date.now(), model: "claude-opus-5-5", cost: 0.5 });
    await store.usage.add({ sessionId: "s2", ts: Date.now(), model: "claude-opus-5-5", cost: 0.25 });
    await store.close();
  });

  async function statusline(env: NodeJS.ProcessEnv, ...argv: string[]) {
    const out: string[] = [];
    const base = io(out);
    const code = await run(["statusline", ...argv], { ...base, env: { ...base.env, ...env } });
    return { code, out: out.join("\n") };
  }

  it("shows the session grenier run started, then today", async () => {
    expect(await statusline({ GRENIER_SESSION: "s1" })).toEqual({
      code: 0,
      out: "grenier · session $4.50 spent, $0.00 cached · today $0.75 spent, $0.00 cached",
    });
  });

  it("finds the session in the base URL when GRENIER_SESSION is not set", async () => {
    expect((await statusline({ ANTHROPIC_BASE_URL: "http://127.0.0.1:7788/s/s2" })).out).toBe(
      "grenier · session $0.25 spent, $0.00 cached · today $0.75 spent, $0.00 cached",
    );
  });

  it("shows today per project with --today, whatever the session", async () => {
    expect((await statusline({ GRENIER_SESSION: "s1" }, "--today")).out).toBe(
      "(not started with grenier run): $0.50 spent, $0.00 cached\napp: $0.25 spent, $0.00 cached",
    );
  });
});

describe("grenier run", () => {
  it("gives the command the session's base URL and id, records the session and returns its exit code", async () => {
    execFileSync("git", ["init", "-q", dir]);
    const err: string[] = [];
    const out = join(dir, "out.txt");
    const code = await runAgent(
      [
        "--",
        process.execPath,
        "-e",
        `const { env } = process; require("fs").writeFileSync(${JSON.stringify(out)}, \`\${env.ANTHROPIC_BASE_URL} \${env.GRENIER_SESSION}\`); process.exit(3)`,
      ],
      io([], err),
      { startDaemon: async () => ({ pid: 1 }) },
    );

    expect(code).toBe(3);
    const store = db();
    const [session] = await store.sessions.list();
    await store.close();
    expect(session).toMatchObject({ client: "node", cwd: dir, repoRoot: dir, repoId: null });
    expect(session?.endedAt).not.toBeNull();
    expect(readFileSync(out, "utf8")).toBe(`http://127.0.0.1:7788/s/${session?.id} ${session?.id}`);
    expect(err[0]).toBe(`grenier: session ${session?.id}, through http://127.0.0.1:7788/s/${session?.id}`);
  });

  it("points Codex at the proxy through its own setting, since it reads no base URL from the environment", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const out = join(dir, "codex-args");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\n`);
    chmodSync(join(bin, "codex"), 0o755);
    const base = io();
    const code = await runAgent(
      ["codex", "exec", "hello"],
      { ...base, env: { ...base.env, PATH: `${bin}:${process.env.PATH}` } },
      { startDaemon: async () => ({ pid: 1 }) },
    );

    expect(code).toBe(0);
    const store = db();
    const [session] = await store.sessions.list();
    await store.close();
    expect(readFileSync(out, "utf8").split("\n")).toEqual([
      "-c",
      `openai_base_url="http://127.0.0.1:7788/s/${session?.id}/openai/v1"`,
      "exec",
      "hello",
      "",
    ]);
    expect(agentArgs("/usr/bin/codex", ["-c", 'openai_base_url="x"'], "y", false)).toEqual([
      "-c",
      'openai_base_url="x"',
    ]);
  });

  it("tells Claude Code in a repository to recall first, unless it gives its own system prompt", () => {
    expect(asksFirst("/usr/local/bin/claude", ["-p", "hi"], true)).toBe(true);
    expect(agentArgs("claude", ["-p", "hi"], "y", true)).toEqual(["--append-system-prompt", ASK_FIRST, "-p", "hi"]);
    expect(ASK_FIRST).toContain("mcp__grenier__recall");
    expect(asksFirst("claude", ["-p", "hi"], false)).toBe(false);
    expect(asksFirst("codex", ["exec"], true)).toBe(false);
    for (const own of ["--append-system-prompt", "--system-prompt-file=prompt.md", "--append-system-prompt-file"]) {
      expect(asksFirst("claude", [own, "x"], true)).toBe(false);
    }
  });
});

describe("grenier key", () => {
  it("makes the personal key once, and takes the same key from another machine", async () => {
    const first = await grenier("key");
    expect(first.out).toMatch(/^gv1_[\w-]{43}\n/);
    const key = first.out.split("\n")[0] as string;
    expect((await grenier("key")).out.split("\n")[0]).toBe(key);
    expect((await grenier("key", "set", key)).code).toBe(0);
    expect((await grenier("key", "set", "gv1_not-a-key")).code).toBe(1);
    expect((await grenier("key", "set", `gv1_${"A".repeat(43)}`)).err).toContain("another personal key");
  });
});
