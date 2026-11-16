import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { version } from "../../../apps/cli/package.json";
import { run } from "../../../apps/cli/src/cli.ts";
import { run as runAgent } from "../../../apps/cli/src/commands/run.ts";
import { daemonPid, pidFile } from "../../../apps/cli/src/daemon.ts";
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

  it("prints the usage with no command, help, or --help", async () => {
    for (const argv of [[], ["help"], ["--help"], ["status", "-h"]]) {
      const result = await grenier(...argv);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/^Usage: grenier <command>/);
    }
  });

  it("exits with 2 on an unknown command, option or argument", async () => {
    for (const argv of [["frobnicate"], ["--frobnicate"], ["status", "extra"], ["report", "--by", "week"]]) {
      const result = await grenier(...argv);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/^grenier: /);
      expect(result.err).toContain("Usage: grenier <command>");
    }
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

  it("shows what the config file sets", async () => {
    await grenier("status");
    writeFileSync(join(home, "config.toml"), "[proxy]\nport = 9000\n");
    const result = await grenier("status");
    expect(result.out).toContain(`config    ${join(home, "config.toml")}\n`);
    expect(result.out).toContain("proxy     127.0.0.1:9000 → https://api.anthropic.com");
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

describe("daemonPid", () => {
  it("is null without a pid file, the pid of a live process, and null for a dead one or garbage", async () => {
    expect(daemonPid(home)).toBeNull();
    await grenier("status");
    writeFileSync(pidFile(home), `${process.pid}\n`);
    expect(daemonPid(home)).toBe(process.pid);
    writeFileSync(pidFile(home), "2147483646\n");
    expect(daemonPid(home)).toBeNull();
    writeFileSync(pidFile(home), "not a pid\n");
    expect(daemonPid(home)).toBeNull();
  });
});

describe("grenier budget", () => {
  it("shows no limit by default, then the limits set, and removes one with off", async () => {
    expect((await grenier("budget")).out.split("\n")).toEqual(["daily           no limit", "session         no limit"]);

    const set = await grenier(
      "budget",
      "set",
      "--daily",
      "10",
      "--session",
      "2.5",
      "--repo",
      "app=1",
      "--repo",
      "api=3",
    );
    expect(set.code).toBe(0);
    expect(set.out.split("\n")).toEqual([
      "daily           $10.00 a day",
      "session         $2.50 a session",
      "repo api        $3.00 a day",
      "repo app        $1.00 a day",
    ]);

    expect((await grenier("budget", "set", "--repo", "app=off")).out).not.toContain("repo app");
  });

  it("shows the config file's limits when none is set", async () => {
    await grenier("status");
    writeFileSync(join(home, "config.toml"), "[budgets]\ndaily = 10\nsession = 3\n");
    expect((await grenier("budget")).out).toContain("daily           $10.00 a day");
  });

  it("refuses an amount that is not one", async () => {
    for (const args of [["--daily", "ten"], ["--daily", "-1"], ["--repo", "app"], []]) {
      expect((await grenier("budget", "set", ...args)).code).toBe(2);
    }
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

  it("fails for an unknown session", async () => {
    expect(await grenier("resume", "nope")).toMatchObject({ code: 1, err: 'grenier: no session "nope"' });
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

  it("says when there is nothing", async () => {
    expect((await grenier("report")).out).toBe("No requests in this period.");
  });
});

describe("grenier run", () => {
  it("gives the command the session's base URL, records the session and returns the command's exit code", async () => {
    execFileSync("git", ["init", "-q", dir]);
    const err: string[] = [];
    const out = join(dir, "out.txt");
    const code = await runAgent(
      [
        "--",
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(out)}, process.env.ANTHROPIC_BASE_URL); process.exit(3)`,
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
    expect(readFileSync(out, "utf8")).toBe(`http://127.0.0.1:7788/s/${session?.id}`);
    expect(err[0]).toBe(`grenier: session ${session?.id}, through http://127.0.0.1:7788/s/${session?.id}`);
  });

  it("returns 127 for a command that does not exist", async () => {
    const err: string[] = [];
    const code = await runAgent(["grenier-no-such-command"], io([], err), { startDaemon: async () => ({ pid: 1 }) });
    expect(code).toBe(127);
    expect(err.at(-1)).toBe("grenier: cannot run grenier-no-such-command: not found");
  });

  it("needs a command", async () => {
    expect((await grenier("run")).code).toBe(2);
    expect((await grenier("run", "--")).code).toBe(2);
  });
});
