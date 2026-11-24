import { execFileSync } from "node:child_process";
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
import { type GrenierPaths, resolvePaths } from "@grenier/core/node";
import { ASK_FIRST } from "@grenier/gateway";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { version } from "../../../apps/cli/package.json";
import { run } from "../../../apps/cli/src/cli.ts";
import { agentArgs, asksFirst, run as runAgent } from "../../../apps/cli/src/commands/run.ts";
import { daemonState } from "../../../apps/cli/src/daemon.ts";
import type { Io } from "../../../apps/cli/src/io.ts";

let dir: string;
let home: string;
let paths: GrenierPaths;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-cli-")));
  home = join(dir, ".grenier");
  paths = resolvePaths({ GRENIER_HOME: home });
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
  return openSqliteStore(paths.db);
}

describe("grenier --version and help", () => {
  it("prints the version and the two commands", async () => {
    expect(await grenier("--version")).toEqual({ code: 0, out: version, err: "" });
    expect((await grenier("-v")).out).toBe(version);
    const help = (await grenier("--help")).out;
    expect(help).toContain("run -- <command>");
    expect(help).toContain("mcp serve");
    expect(help).not.toContain("daemon");
  });

  it("exits with 2 on an unknown command or argument", async () => {
    for (const argv of [
      ["frobnicate"],
      ["--frobnicate"],
      ["today", "extra"],
      ["mcp", "install", "claude-code"],
      ["status"],
    ]) {
      const result = await grenier(...argv);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/^grenier: /);
      expect(result.err).toContain("Usage: grenier <command>");
    }
  });
});

describe("the menu bar's grenier today", () => {
  it("creates the home directory and the database on first run, and refuses a config it cannot read", async () => {
    expect(await grenier("today")).toEqual({ code: 0, out: "Nothing spent yet", err: "" });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(existsSync(paths.db)).toBe(true);
    writeFileSync(paths.config, "[proxy]\nport = 0\n");
    expect(await grenier("today")).toEqual({
      code: 1,
      out: "",
      err: `grenier: Invalid config in ${paths.config}:\n  proxy.port: Too small: expected number to be >=1`,
    });
  });

  it("shows today's spend per project", async () => {
    await grenier("today");
    const store = db();
    const yesterday = Date.now() - 2 * 86_400_000;
    await store.sessions.create({ id: "s1", startedAt: yesterday });
    await store.sessions.create({ id: "s2", startedAt: Date.now(), repoRoot: "/work/app", repoId: "r1" });
    await store.usage.add({ sessionId: "s1", ts: yesterday, model: "claude-opus-5-5", cost: 4 });
    await store.usage.add({ sessionId: "s1", ts: Date.now(), model: "claude-opus-5-5", cost: 0.5 });
    await store.usage.add({ sessionId: "s2", ts: Date.now(), model: "claude-opus-5-5", cost: 0.25 });
    await store.close();
    expect((await grenier("today")).out).toBe(
      "(not started with grenier run): $0.50 spent, $0.00 cached\napp: $0.25 spent, $0.00 cached",
    );
  });
});

describe("the daemon's identity", () => {
  it("is stopped without a record, or with one naming a dead pid or garbage", async () => {
    await grenier("today");
    expect(await daemonState(paths)).toEqual({ state: "stopped" });
    writeFileSync(paths.daemonInfo, JSON.stringify({ pid: 2147483646, port: 7799, version: "0.0.0" }));
    expect(await daemonState(paths)).toEqual({ state: "stopped" });
    writeFileSync(paths.daemonInfo, "not json");
    expect(await daemonState(paths)).toEqual({ state: "stopped" });
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
    const session = await store.sessions.get(readFileSync(out, "utf8").split(" ")[1] as string);
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
    const id = /\/s\/([^/]+)\/openai/.exec(readFileSync(out, "utf8"))?.[1] as string;
    const session = await store.sessions.get(id);
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
