import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfig } from "@grenier/core";
import { ensureDirectories, loadConfig, resolvePaths } from "@grenier/core/node";
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
    });
  });

  it("moves both files with GRENIER_HOME", () => {
    expect(resolvePaths({ GRENIER_HOME: "/data/g" }, "/home/me")).toEqual({
      home: "/data/g",
      config: "/data/g/config.toml",
      db: "/data/g/grenier.db",
    });
  });

  it("lets GRENIER_CONFIG and GRENIER_DB override each path", () => {
    const paths = resolvePaths({ GRENIER_CONFIG: "/etc/g.toml", GRENIER_DB: "/var/g.db" }, "/home/me");
    expect(paths).toEqual({ home: "/home/me/.grenier", config: "/etc/g.toml", db: "/var/g.db" });
  });

  it("ignores empty variables", () => {
    expect(resolvePaths({ GRENIER_HOME: "", GRENIER_DB: "" }, "/home/me").db).toBe("/home/me/.grenier/grenier.db");
  });
});

describe("ensureDirectories", () => {
  it("creates the home and database directories, private to the user", () => {
    const paths = { home: join(dir, "home"), config: join(dir, "home/config.toml"), db: join(dir, "data/g.db") };
    ensureDirectories(paths);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "data")).isDirectory()).toBe(true);
  });

  it("leaves existing directories as they are", () => {
    const paths = { home: dir, config: join(dir, "config.toml"), db: join(dir, "grenier.db") };
    ensureDirectories(paths);
    ensureDirectories(paths);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});

describe("loadConfig", () => {
  it("returns the defaults when there is no file", () => {
    expect(loadConfig(join(dir, "missing.toml"))).toEqual({ config: defaultConfig(), found: false });
  });

  it("reads a file", () => {
    const file = join(dir, "config.toml");
    writeFileSync(file, "[proxy]\nport = 8000\n");
    const loaded = loadConfig(file);
    expect(loaded.found).toBe(true);
    expect(loaded.config.proxy.port).toBe(8000);
  });

  it("names the file in the error for an invalid one", () => {
    const file = join(dir, "config.toml");
    writeFileSync(file, "[proxy]\nport = 0\n");
    expect(() => loadConfig(file)).toThrow(ConfigError);
    expect(() => loadConfig(file)).toThrow(`Invalid config in ${file}:`);
  });
});
