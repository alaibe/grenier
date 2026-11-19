import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, type FSWatcher, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncSources, watchMarkdown } from "@grenier/connectors";
import { repoText } from "@grenier/connectors/git";
import { createGateway } from "@grenier/gateway";
import { syncOnce, type TeamBudget, teamApi, vaultPull, vaultPush } from "@grenier/index";
import { cacheSavingsOf, loadPrices } from "@grenier/log";
import { openSqliteStore } from "@grenier/store/sqlite";
import { serve } from "@hono/node-server";
import { version } from "../package.json";
import { deviceId, vaultKey } from "./commands/vault.ts";
import { embedderLoader, gitFiles, repoResolver } from "./exploration.ts";
import { CommandError, environment, type Io, writeAtomically } from "./io.ts";
import { desktopNotifier } from "./notify.ts";
import { teamClient } from "./team.ts";

/** Where daemons before daemon.json wrote their pid. */
export function pidFile(home: string): string {
  return join(home, "daemon.pid");
}

export function logFile(home: string): string {
  return join(home, "daemon.log");
}

/** The desktop app's key to the admin API: made once, readable by this user only. */
export function adminToken(home: string): string {
  const file = join(home, "admin-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = `ga_${randomBytes(32).toString("base64url")}`;
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** What the running daemon writes about itself once it listens, and removes when it stops. */
export function infoFile(home: string): string {
  return join(home, "daemon.json");
}

export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
}

export type DaemonState =
  | { state: "running"; pid: number; port: number; version: string | null }
  | { state: "stopped" }
  /** The recorded pid belongs to another program: the daemon stopped without cleaning up, and the pid was reused. */
  | { state: "stale"; pid: number };

/** What the daemon recorded: daemon.json, or the pid file alone of a daemon from before it. */
function recorded(home: string): { pid: number; port?: number } | null {
  try {
    const info = JSON.parse(readFileSync(infoFile(home), "utf8")) as Partial<DaemonInfo>;
    if (Number.isInteger(info.pid) && (info.pid as number) > 0) {
      return { pid: info.pid as number, ...(Number.isInteger(info.port) ? { port: info.port as number } : {}) };
    }
  } catch {
    // No daemon.json, or one cut short: fall back to the pid file.
  }
  try {
    const pid = Number.parseInt(readFileSync(pidFile(home), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The daemon's own answer to who it is, through the admin API: null when nothing of ours answers on `port`. */
async function health(home: string, port: number): Promise<{ pid: number; version: string } | null> {
  const tokenFile = join(home, "admin-token");
  if (!existsSync(tokenFile)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/health`, {
      headers: { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return (await response.json()) as { pid: number; version: string };
  } catch {
    return null;
  }
}

/**
 * Whether a process's command line is a grenier daemon's, for a daemon too old to answer /admin/health. False where it
 * cannot be read (Windows), so such a pid is never signalled.
 */
function looksLikeDaemon(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    // The daemon's own command line ends with `grenier.js daemon` (or `grenier daemon`); a log viewer does not.
    return /(?:^|[\\/\s])grenier(?:\.js)?\s+daemon\s*$/.test(command.trim());
  } catch {
    return false;
  }
}

/** Whether the daemon runs, checked with the daemon itself: a pid file alone can name a pid since reused. */
export async function daemonState(home: string, configuredPort: number): Promise<DaemonState> {
  const found = recorded(home);
  if (found === null || !isAlive(found.pid)) return { state: "stopped" };
  const port = found.port ?? configuredPort;
  const answer = await health(home, port);
  if (answer?.pid === found.pid) return { state: "running", pid: found.pid, port, version: answer.version };
  if (answer === null && looksLikeDaemon(found.pid)) {
    return { state: "running", pid: found.pid, port, version: null };
  }
  return { state: "stale", pid: found.pid };
}

function forget(home: string): void {
  rmSync(infoFile(home), { force: true });
  rmSync(pidFile(home), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // In a container whose PID 1 does not reap orphans, an exited daemon stays a zombie that kill(0) still finds.
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DAY = 86_400_000;
const PRUNE_EVERY = 6 * 60 * 60 * 1000;

/** `grenier daemon`: serves the proxy in the foreground until SIGTERM or SIGINT. */
export async function runDaemon(io: Io): Promise<number> {
  const { paths, config } = environment(io);
  const current = await daemonState(paths.home, config.proxy.port);
  if (current.state === "running") throw new CommandError(`the daemon is already running (pid ${current.pid})`);

  const store = openSqliteStore(paths.db);
  const port = config.proxy.port;
  const prices = loadPrices(config.prices);
  const embedder = embedderLoader(config, paths, io.err);
  const team = teamClient(config, paths, io.env);
  const app = createGateway({
    store,
    config,
    prices,
    port,
    notify: desktopNotifier(io.err),
    log: io.err,
    mcp: { files: gitFiles, embedder, resolveRepo: repoResolver(null), version },
    admin: {
      token: adminToken(paths.home),
      version,
      log: io.err,
      readFile: repoText,
      files: gitFiles,
      identity: { pid: process.pid, port },
    },
    ...(team ? { teamBudget: () => teamApi<TeamBudget>(team, "/api/budget") } : {}),
  });

  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    await store.close();
    const code = (error as NodeJS.ErrnoException).code;
    throw new CommandError(
      code === "EADDRINUSE" ? `127.0.0.1:${port} is in use; set [proxy] port in ${paths.config}` : String(error),
    );
  }

  rmSync(pidFile(paths.home), { force: true });
  writeAtomically(infoFile(paths.home), `${JSON.stringify({ pid: process.pid, port, version })}\n`);
  io.err(`grenier ${version} daemon listening on 127.0.0.1:${port} (pid ${process.pid})`);

  // Team sync: push and pull on a timer; while the server cannot be reached, the local cache carries on alone.
  let syncing = false;
  let lastError = "";
  const sync = async () => {
    if (!team || syncing) return;
    syncing = true;
    try {
      const resolved = await embedder();
      const { refused } = await syncOnce({
        store,
        embedder: resolved,
        team,
        savedOf: (row) => cacheSavingsOf(row.model, row.cacheReadTokens ?? 0, prices),
        shareAll: config.cache.share_with_team,
        device: await deviceId(store),
      });
      if (refused.answers + refused.summaries > 0) {
        io.err(
          `grenier: the team server refused ${refused.answers} answer(s) and ${refused.summaries} summary(ies); they stay on this machine, and the desktop app's Cache page says why`,
        );
      }
      const key = vaultKey(paths);
      if (key) {
        const device = await deviceId(store);
        await vaultPush(store, team, key, device);
        await vaultPull(store, team, key, device);
      }
      await store.team.set("last_sync", String(Date.now()));
      if (lastError) io.err("grenier: team sync works again");
      lastError = "";
    } catch (error) {
      const message = (error as Error).message;
      if (message !== lastError) io.err(`grenier: team sync failed, will retry: ${message}`);
      lastError = message;
    } finally {
      syncing = false;
    }
  };
  const timer = team ? setInterval(() => void sync(), config.team.sync_interval * 1000) : undefined;
  if (team) void sync();

  // Personal-data sources: every one on a timer, and markdown folders as soon as they change.
  let pulling = false;
  let again = false;
  const watchers = new Map<string, FSWatcher>();
  const pull = async (only?: string): Promise<void> => {
    if (pulling) {
      again = true;
      return;
    }
    pulling = true;
    try {
      // Watch before reading, so a change made while a folder is read is not missed until the next timer.
      for (const source of await store.sources.list()) {
        const path = source.config.path;
        if (source.kind !== "markdown" || typeof path !== "string" || watchers.has(source.id)) continue;
        try {
          watchers.set(
            source.id,
            watchMarkdown(path, () => void pull(source.name)),
          );
        } catch (error) {
          io.err(`grenier: cannot watch ${path}: ${(error as Error).message}`);
        }
      }
      await syncSources(store, io.err, only);
    } finally {
      pulling = false;
    }
    if (again) {
      again = false;
      return pull();
    }
  };
  const sourceTimer = setInterval(() => void pull(), config.sources.sync_interval * 1000);
  void pull();

  const prune = async () => {
    const { steps_days, usage_days } = config.retention;
    const before = (days: number) => Date.now() - days * DAY;
    try {
      if (steps_days > 0) await store.steps.prune(before(steps_days));
      if (usage_days > 0) {
        await store.usage.prune(before(usage_days));
        await store.events.prune(before(usage_days));
      }
    } catch (error) {
      io.err(`grenier: could not remove old traces and usage: ${(error as Error).message}`);
    }
  };
  const pruneTimer = setInterval(() => void prune(), PRUNE_EVERY);
  void prune();

  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
  // A second signal while shutting down must not cut the cleanup short.
  const ignore = () => {};
  process.on("SIGTERM", ignore);
  process.on("SIGINT", ignore);
  if (timer) clearInterval(timer);
  clearInterval(sourceTimer);
  clearInterval(pruneTimer);
  for (const watcher of watchers.values()) watcher.close();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // A stream still open is cut after a grace period, so stopping never waits for an agent to finish.
  const cut = setTimeout(() => (server as { closeAllConnections?: () => void }).closeAllConnections?.(), 3000);
  await closed;
  clearTimeout(cut);
  await store.close();
  forget(paths.home);
  process.off("SIGTERM", ignore);
  process.off("SIGINT", ignore);
  return 0;
}

/** Starts the daemon in the background and waits until it answers; or finds the one already running. */
export async function startDaemon(
  io: Io,
): Promise<{ pid: number; port: number; version: string | null; started: boolean }> {
  const { paths, config } = environment(io);
  const current = await daemonState(paths.home, config.proxy.port);
  if (current.state === "running") return { ...current, started: false };

  const log = openSync(logFile(paths.home), "a", 0o600);
  const [command = process.execPath, ...args] = io.self;
  const child = spawn(command, [...args, "daemon"], { detached: true, stdio: ["ignore", log, log], env: io.env });
  closeSync(log);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  for (let waited = 0; waited < 10_000; waited += 50) {
    const now = await daemonState(paths.home, config.proxy.port);
    // Another start may have won the race: its daemon is as good as ours.
    if (now.state === "running") return { ...now, started: now.pid === child.pid };
    if (exited) break;
    await sleep(50);
  }
  const tail = readFileSync(logFile(paths.home), "utf8").trim().split("\n").slice(-5).join("\n");
  throw new CommandError(`the daemon did not start. ${logFile(paths.home)} says:\n${tail}`);
}

/**
 * Stops the daemon and waits for it to exit. Returns its pid, or null if it was not running. A recorded pid that is
 * another program's is never signalled: the stale record is removed instead.
 */
export async function stopDaemon(io: Io): Promise<{ pid: number | null; stale?: number }> {
  const { paths, config } = environment(io);
  const current = await daemonState(paths.home, config.proxy.port);
  if (current.state === "stale") {
    forget(paths.home);
    return { pid: null, stale: current.pid };
  }
  if (current.state === "stopped") return { pid: null };
  const { pid } = current;
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 10_000; waited += 50) {
    if (!isAlive(pid) || recorded(paths.home) === null) return { pid };
    await sleep(50);
  }
  throw new CommandError(`the daemon (pid ${pid}) did not stop; see ${logFile(paths.home)}`);
}
