import { type Config, ConfigError } from "@grenier/core";
import { ensureDirectories, type GrenierPaths, loadConfig, resolvePaths } from "@grenier/core/node";
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

/** A failure to report as `grenier: <message>` with exit code 1. */
export class CommandError extends Error {
  override name = "CommandError";
}

/** A wrong command line, reported with the usage and exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export function isReported(error: unknown): error is Error {
  return error instanceof CommandError || error instanceof ConfigError || error instanceof StoreError;
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

/** Runs `use` with the database open, and closes it after. */
export async function withStore<T>(paths: GrenierPaths, use: (store: Store) => Promise<T>): Promise<T> {
  const store = openSqliteStore(paths.db);
  try {
    return await use(store);
  } finally {
    await store.close();
  }
}
