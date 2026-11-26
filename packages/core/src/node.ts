import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Config, ConfigError, defaultConfig, parseConfig } from "./config.ts";

export interface GrenierPaths {
  /** GRENIER_HOME, else ~/.grenier: it holds every file below, but a config or database moved elsewhere. */
  home: string;
  /** GRENIER_CONFIG, else <home>/config.toml. */
  config: string;
  /** GRENIER_DB, else <home>/grenier.db. */
  db: string;
  /** The desktop app's key to the admin API. */
  adminToken: string;
  /** This machine's token for the team store, once it joined or deployed one. */
  teamToken: string;
  /** The Cloudflare API token the last deploy used, kept so an update of the team store takes one click. */
  deployToken: string;
  /** The person's own key for the Me folder. */
  personalKey: string;
  /** What the running daemon writes about itself: its pid, port and version. */
  daemonInfo: string;
  /** Where the daemon started in the background writes what it says. */
  daemonLog: string;
  /** The embedding model, fetched on first use. */
  models: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): GrenierPaths {
  const home = resolve(env.GRENIER_HOME || join(userHome, ".grenier"));
  return {
    home,
    config: resolve(env.GRENIER_CONFIG || join(home, "config.toml")),
    db: resolve(env.GRENIER_DB || join(home, "grenier.db")),
    adminToken: join(home, "admin-token"),
    teamToken: join(home, "team-token"),
    deployToken: join(home, "cloudflare-token"),
    personalKey: join(home, "personal.key"),
    daemonInfo: join(home, "daemon.json"),
    daemonLog: join(home, "daemon.log"),
    models: join(home, "models"),
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

/** Writes a file readable by this user only, all at once: a reader sees the old text or the new, never half. */
export function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Sets `key = "value"` in a TOML table, editing the text so comments and other settings stay as they were. */
export function withTomlValue(text: string, table: string, key: string, value: string | number | boolean): string {
  const line = `${key} = ${JSON.stringify(value)}`;
  const lines = text.split("\n");
  const start = lines.findIndex((entry) => entry.trim() === `[${table}]`);
  if (start === -1) {
    const body = text.replace(/\n*$/, "");
    return `${body}${body ? "\n\n" : ""}[${table}]\n${line}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++;
  const existing = lines.findIndex(
    (entry, index) => index > start && index < end && new RegExp(`^\\s*${key}\\s*=`).test(entry),
  );
  if (existing !== -1) lines[existing] = line;
  else lines.splice(start + 1, 0, line);
  return lines.join("\n");
}

/** The rules a person sets for this machine, as config.toml's [machine] table takes them. */
const RULES = [
  "workdir",
  "routines",
  "plugged_in",
  "idle_minutes",
  "cpu_max",
  "memory_max",
  "hours",
  "agent",
  "name",
] as const;

/** Writes rules into config.toml, keeping everything else, once the whole file still reads as a valid config. */
export function setRules(paths: GrenierPaths, change: Record<string, unknown>): Config {
  let text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  for (const [key, value] of Object.entries(change)) {
    if (!(RULES as readonly string[]).includes(key)) throw new ConfigError(`[machine] has no ${key}`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new ConfigError(`${key} takes a value`);
    }
    if (key === "workdir" && !(isAbsolute(String(value)) && existsSync(String(value)))) {
      throw new ConfigError("the work folder is a full path to a folder on this machine, as /home/me/Work");
    }
    text = withTomlValue(text, "machine", key, value);
  }
  const config = parseConfig(text, paths.config);
  writeAtomically(paths.config, text.endsWith("\n") ? text : `${text}\n`);
  return config;
}
