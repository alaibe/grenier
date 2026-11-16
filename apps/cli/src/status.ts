import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirectories, loadConfig, resolvePaths } from "@grenier/core/node";
import { openSqliteStore } from "@grenier/store/sqlite";

/** The daemon writes its pid here while it runs. */
export function pidFile(home: string): string {
  return join(home, "daemon.pid");
}

/** The pid of the running daemon, or null when there is none. */
export function daemonPid(home: string): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidFile(home), "utf8"), 10);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

/** Creates ~/.grenier and the database on first run, then describes them. Throws ConfigError or StoreError. */
export async function status(env: NodeJS.ProcessEnv, version: string): Promise<string[]> {
  const paths = resolvePaths(env);
  ensureDirectories(paths);
  const { config, found } = loadConfig(paths.config);

  const store = openSqliteStore(paths.db);
  let schema: number;
  try {
    schema = await store.schemaVersion();
  } finally {
    await store.close();
  }

  const pid = daemonPid(paths.home);
  return [
    `grenier ${version}`,
    `config    ${paths.config}${found ? "" : " (not found, using defaults)"}`,
    `database  ${paths.db} (schema ${schema})`,
    `proxy     127.0.0.1:${config.proxy.port} → ${config.proxy.upstream_anthropic}`,
    `daemon    ${pid === null ? "stopped" : `running (pid ${pid})`}`,
  ];
}
