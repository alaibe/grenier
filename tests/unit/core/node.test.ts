import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfig } from "@grenier/core";
import { ensureDirectories, loadConfig, resolvePaths, setRules, withTomlValue } from "@grenier/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grenier-core-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  it("puts everything in ~/.grenier by default", () => {
    expect(resolvePaths({}, "/home/me")).toEqual({
      home: "/home/me/.grenier",
      config: "/home/me/.grenier/config.toml",
      db: "/home/me/.grenier/grenier.db",
      adminToken: "/home/me/.grenier/admin-token",
      teamToken: "/home/me/.grenier/team-token",
      deployToken: "/home/me/.grenier/cloudflare-token",
      personalKey: "/home/me/.grenier/personal.key",
      daemonInfo: "/home/me/.grenier/daemon.json",
      daemonLog: "/home/me/.grenier/daemon.log",
      models: "/home/me/.grenier/models",
    });
  });

  it("moves both files with GRENIER_HOME", () => {
    expect(resolvePaths({ GRENIER_HOME: "/data/g" }, "/home/me")).toEqual({
      home: "/data/g",
      config: "/data/g/config.toml",
      db: "/data/g/grenier.db",
      adminToken: "/data/g/admin-token",
      teamToken: "/data/g/team-token",
      deployToken: "/data/g/cloudflare-token",
      personalKey: "/data/g/personal.key",
      daemonInfo: "/data/g/daemon.json",
      daemonLog: "/data/g/daemon.log",
      models: "/data/g/models",
    });
  });

  it("lets GRENIER_CONFIG and GRENIER_DB override each path", () => {
    const paths = resolvePaths({ GRENIER_CONFIG: "/etc/g.toml", GRENIER_DB: "/var/g.db" }, "/home/me");
    expect(paths).toEqual({
      home: "/home/me/.grenier",
      config: "/etc/g.toml",
      db: "/var/g.db",
      adminToken: "/home/me/.grenier/admin-token",
      teamToken: "/home/me/.grenier/team-token",
      deployToken: "/home/me/.grenier/cloudflare-token",
      personalKey: "/home/me/.grenier/personal.key",
      daemonInfo: "/home/me/.grenier/daemon.json",
      daemonLog: "/home/me/.grenier/daemon.log",
      models: "/home/me/.grenier/models",
    });
  });
});

describe("ensureDirectories", () => {
  it("creates the home and database directories, private to the user", () => {
    const paths = { ...resolvePaths({ GRENIER_HOME: join(dir, "home") }), db: join(dir, "data/g.db") };
    ensureDirectories(paths);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "data")).isDirectory()).toBe(true);
  });
});

describe("loadConfig", () => {
  it("returns the defaults when there is no file", () => {
    expect(loadConfig(join(dir, "missing.toml"))).toEqual(defaultConfig());
  });

  it("reads a file", () => {
    const file = join(dir, "config.toml");
    writeFileSync(file, "[proxy]\nport = 8000\n");
    expect(loadConfig(file).proxy.port).toBe(8000);
  });

  it("names the file in the error for an invalid one", () => {
    const file = join(dir, "config.toml");
    writeFileSync(file, "[proxy]\nport = 0\n");
    expect(() => loadConfig(file)).toThrow(ConfigError);
    expect(() => loadConfig(file)).toThrow(`Invalid config in ${file}:`);
  });
});

describe("setRules", () => {
  it("writes the machine's rules into config.toml, keeping the rest, and refuses a rule or value it does not know", () => {
    const paths = resolvePaths({ GRENIER_HOME: dir });
    writeFileSync(paths.config, "# mine\n[proxy]\nport = 8000\n");
    expect(setRules(paths, { routines: true, hours: "22-7" }).machine).toMatchObject({ routines: true, hours: "22-7" });
    expect(readFileSync(paths.config, "utf8")).toBe(
      '# mine\n[proxy]\nport = 8000\n\n[machine]\nhours = "22-7"\nroutines = true\n',
    );
    expect(() => setRules(paths, { speed: 1 })).toThrow(ConfigError);
    expect(() => setRules(paths, { hours: "noon" })).toThrow('takes hours as "22-7"');
    expect(loadConfig(paths.config).machine.hours).toBe("22-7");
  });
});

describe("withTomlValue", () => {
  it("adds a table, or sets a key inside an existing one, keeping the rest", () => {
    expect(withTomlValue("", "team", "url", "https://x")).toBe('[team]\nurl = "https://x"\n');
    expect(withTomlValue('[proxy]\nport = 1\n\n[team]\nurl = "old"\n', "team", "url", "new")).toBe(
      '[proxy]\nport = 1\n\n[team]\nurl = "new"\n',
    );
  });
});
