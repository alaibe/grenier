import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, ConfigError } from "@grenier/core";
import { ensureDirectories, type GrenierPaths, loadConfig, resolvePaths } from "@grenier/core/node";
import { StoreUseError } from "@grenier/index";
import { type Store, StoreError } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";

export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** How to start this program again, for the daemon: [node, script]. */
  self: string[];
  /** All of standard input, for a command that reads it. */
  stdin?: () => Promise<string>;
}

/** A failure to report as `grenier: <message>` with exit code 1. */
export class CommandError extends Error {
  override name = "CommandError";
}

/** A wrong command line, reported with the usage and exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export function isReported(error: unknown): error is Error {
  return (
    error instanceof CommandError ||
    error instanceof ConfigError ||
    error instanceof StoreError ||
    error instanceof StoreUseError
  );
}

export interface Environment {
  paths: GrenierPaths;
  config: Config;
  configFound: boolean;
}

/** The paths and config, with ~/.grenier created on first run. Throws ConfigError for an invalid config. */
export function environment(io: Io): Environment {
  const paths = resolvePaths(io.env);
  ensureDirectories(paths);
  const { config, found } = loadConfig(paths.config);
  return { paths, config, configFound: found };
}

export async function withStore<T>(paths: GrenierPaths, use: (store: Store) => Promise<T>): Promise<T> {
  const store = openSqliteStore(paths.db);
  try {
    return await use(store);
  } finally {
    await store.close();
  }
}

/** Writes a file readable by this user only, all at once: a reader sees the old text or the new, never half. */
export function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}
