import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { version } from "../../../apps/cli/package.json";
import { run } from "../../../apps/cli/src/cli.ts";
import { daemonPid, pidFile } from "../../../apps/cli/src/status.ts";

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grenier-cli-"));
  home = join(dir, ".grenier");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function grenier(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env: { GRENIER_HOME: home },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("grenier --version", () => {
  it("prints the version", async () => {
    expect(await grenier("--version")).toEqual({ code: 0, out: version, err: "" });
    expect((await grenier("-v")).out).toBe(version);
  });
});

describe("grenier help", () => {
  it("prints the usage with no command, help, or --help", async () => {
    for (const argv of [[], ["help"], ["--help"], ["status", "-h"]]) {
      const result = await grenier(...argv);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/^Usage: grenier <command>/);
    }
  });

  it("exits with 2 on an unknown command, option or argument", async () => {
    for (const argv of [["frobnicate"], ["--frobnicate"], ["status", "extra"]]) {
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
    const result = await grenier("status");
    expect(result).toEqual({
      code: 1,
      out: "",
      err: `grenier: Invalid config in ${join(home, "config.toml")}:\n  proxy.port: Too small: expected number to be >=1`,
    });
  });
});

describe("daemonPid", () => {
  it("is null without a pid file", () => {
    expect(daemonPid(home)).toBeNull();
  });

  it("is the pid of a live process", async () => {
    await grenier("status");
    writeFileSync(pidFile(home), `${process.pid}\n`);
    expect(daemonPid(home)).toBe(process.pid);
  });

  it("is null for a pid file left by a process that has exited, or holding garbage", async () => {
    await grenier("status");
    writeFileSync(pidFile(home), "2147483646\n");
    expect(daemonPid(home)).toBeNull();
    writeFileSync(pidFile(home), "not a pid\n");
    expect(daemonPid(home)).toBeNull();
  });
});
