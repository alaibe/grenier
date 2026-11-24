import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Config, defaultConfig, parseConfig } from "./config.ts";

export interface GrenierPaths {
  /** Holds the files that have no path of their own: GRENIER_HOME, else ~/.grenier. */
  home: string;
  /** GRENIER_CONFIG, else <home>/config.toml. */
  config: string;
  /** GRENIER_DB, else <home>/grenier.db. */
  db: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): GrenierPaths {
  const home = resolve(env.GRENIER_HOME || join(userHome, ".grenier"));
  return {
    home,
    config: resolve(env.GRENIER_CONFIG || join(home, "config.toml")),
    db: resolve(env.GRENIER_DB || join(home, "grenier.db")),
  };
}

/** Creates the home directory and the database's directory, readable by this user only. */
export function ensureDirectories(paths: GrenierPaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.db), { recursive: true, mode: 0o700 });
}

/** Reads and validates the config file. A missing file means defaults; an invalid one throws a ConfigError. */
export function loadConfig(file: string): Config {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
  return parseConfig(text, file);
}
