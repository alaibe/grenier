import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, type FSWatcher, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
import { CommandError, environment, type Io } from "./io.ts";
import { desktopNotifier } from "./notify.ts";
import { teamClient } from "./team.ts";

/** The daemon writes its pid here while it runs. */
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
  return isAlive(pid) ? pid : null;
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

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DAY = 86_400_000;
const PRUNE_EVERY = 6 * 60 * 60 * 1000;

/** `grenier daemon`: serves the proxy in the foreground until SIGTERM or SIGINT. */
export async function runDaemon(io: Io): Promise<number> {
  const { paths, config } = environment(io);
  const running = daemonPid(paths.home);
  if (running !== null) throw new CommandError(`the daemon is already running (pid ${running})`);

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
    admin: { token: adminToken(paths.home), version, log: io.err, readFile: repoText, files: gitFiles },
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

  writeFileSync(pidFile(paths.home), `${process.pid}\n`, { mode: 0o600 });
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
  if (timer) clearInterval(timer);
  clearInterval(sourceTimer);
  clearInterval(pruneTimer);
  for (const watcher of watchers.values()) watcher.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(pidFile(paths.home), { force: true });
  await store.close();
  return 0;
}

/** Starts the daemon in the background and waits until it answers. Returns its pid. */
export async function startDaemon(io: Io): Promise<{ pid: number; started: boolean }> {
  const { paths, config } = environment(io);
  const running = daemonPid(paths.home);
  if (running !== null) return { pid: running, started: false };

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
    if (exited) break;
    if (daemonPid(paths.home) === child.pid && (await canConnect(config.proxy.port))) {
      return { pid: child.pid, started: true };
    }
    await sleep(50);
  }
  const tail = readFileSync(logFile(paths.home), "utf8").trim().split("\n").slice(-5).join("\n");
  throw new CommandError(`the daemon did not start. ${logFile(paths.home)} says:\n${tail}`);
}

/** Stops the daemon and waits for it to exit. Returns its pid, or null if it was not running. */
export async function stopDaemon(io: Io): Promise<number | null> {
  const { paths } = environment(io);
  const pid = daemonPid(paths.home);
  if (pid === null) return null;
  process.kill(pid, "SIGTERM");
  // Done once it is gone, or once it has removed its pid file on the way out.
  for (let waited = 0; waited < 10_000; waited += 50) {
    if (!isAlive(pid) || !existsSync(pidFile(paths.home))) return pid;
    await sleep(50);
  }
  throw new CommandError(`the daemon (pid ${pid}) did not stop; see ${logFile(paths.home)}`);
}
