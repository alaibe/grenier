import { statSync } from "node:fs";
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
}

/** What this machine refuses to do, and why: the admin API answers with it, and a command exits with code 1. */
export class Refusal extends Error {
  override name = "Refusal";
}

/** A wrong command line, reported with the usage and exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export function isReported(error: unknown): error is Error {
  return (
    error instanceof Refusal ||
    error instanceof ConfigError ||
    error instanceof StoreError ||
    error instanceof StoreUseError
  );
}

/** Whether a path is a folder, following links; false when there is nothing there. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface Environment {
  paths: GrenierPaths;
  config: Config;
}

/** The paths and config, with ~/.grenier created on first run. Throws ConfigError for an invalid config. */
export function environment(io: Io): Environment {
  const paths = resolvePaths(io.env);
  ensureDirectories(paths);
  return { paths, config: loadConfig(paths.config) };
}

export async function withStore<T>(paths: GrenierPaths, use: (store: Store) => Promise<T>): Promise<T> {
  const store = openSqliteStore(paths.db);
  try {
    return await use(store);
  } finally {
    await store.close();
  }
}
