import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "@grenier/gateway";
import type { TeamClient } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import { openSqliteStore } from "@grenier/store/sqlite";
import { serve } from "@hono/node-server";
import { version } from "../package.json";
import { machineRoutes } from "./connect.ts";
import { deployTeamStore } from "./deploy.ts";
import { embedderLoader, gitFiles, repoResolver } from "./exploration.ts";
import { anchorDiffs, installs, joining, routes } from "./host.ts";
import { removeRetired } from "./installs.ts";
import { CommandError, environment, type Io, writeAtomically } from "./io.ts";
import { TeamLink } from "./link.ts";
import { desktopNotifier } from "./notify.ts";
import { routineRoutes } from "./routines.ts";
import { Runner } from "./runner.ts";
import { ensureBaseTops, identity, storeDeps } from "./runtime.ts";
import { teamClient } from "./team.ts";

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
  | { state: "running"; pid: number; port: number; version: string }
  | { state: "stopped" }
  /** The recorded pid belongs to another program: the daemon stopped without cleaning up, and the pid was reused. */
  | { state: "stale"; pid: number };

function recorded(home: string): { pid: number; port: number } | null {
  try {
    const info = JSON.parse(readFileSync(infoFile(home), "utf8")) as Partial<DaemonInfo>;
    return Number.isInteger(info.pid) && (info.pid as number) > 0 && Number.isInteger(info.port)
      ? { pid: info.pid as number, port: info.port as number }
      : null;
  } catch {
    return null;
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

/** Whether the daemon runs, checked with the daemon itself: a recorded pid can have been reused since. */
export async function daemonState(home: string): Promise<DaemonState> {
  const found = recorded(home);
  if (found === null || !isAlive(found.pid)) return { state: "stopped" };
  const answer = await health(home, found.port);
  if (answer?.pid === found.pid) return { ...found, state: "running", version: answer.version };
  return { state: "stale", pid: found.pid };
}

function forget(home: string): void {
  rmSync(infoFile(home), { force: true });
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
  const current = await daemonState(paths.home);
  if (current.state === "running") throw new CommandError(`the daemon is already running (pid ${current.pid})`);

  const store = openSqliteStore(paths.db);
  await ensureBaseTops(store);
  const port = config.proxy.port;
  const prices = loadPrices(config.prices);
  const embedder = embedderLoader(config, paths, io.err);
  const home = homedir();
  let rules = config;
  const notify = desktopNotifier(io.err);
  let team = teamClient(config, paths, io.env);
  let link: TeamLink | null = null;
  const runner = new Runner({
    store,
    config: () => rules,
    port,
    team: () => team,
    storeDeps: () => storeDeps(store, config, embedder),
    tell: async (state) => {
      await link?.tell(state);
    },
    sync: async () => {
      await link?.sync();
    },
    log: io.err,
    notify,
  });
  const linkTo = (client: TeamClient) => {
    const made = new TeamLink(client, store, config, paths, embedder, io.err);
    made.listeners.push((result) => {
      removeRetired(store)
        .then((done) => {
          for (const line of done) io.err(`grenier: ${line}`);
        })
        .catch((error: Error) => io.err(`grenier: could not remove a retired skill or server: ${error.message}`));
      if (result.pulled > 0) void runner.tick(true);
    });
    return made;
  };
  link = team ? linkTo(team) : null;
  const started = (joined: TeamClient) => {
    team = joined;
    link?.stop();
    link = linkTo(joined);
    link.start();
    runner.start();
  };
  const extra = routes(
    joining({ paths, config, store, joined: started }),
    async (method, path, body) => {
      if (path !== "/deploy" || method !== "POST") return null;
      const input = (body ?? {}) as { token?: unknown; name?: unknown; member?: unknown };
      try {
        const deployed = await deployTeamStore(
          {
            paths,
            config,
            store,
            serverDir: fileURLToPath(new URL("./server/", import.meta.url)),
            inTeam: team !== null,
          },
          {
            token: String(input.token ?? ""),
            name: String(input.name ?? "grenier-team"),
            member: String(input.member ?? ""),
          },
        );
        if (deployed.team) started(deployed.team);
        return { status: 200, body: { url: deployed.url, created: deployed.team !== null } };
      } catch (error) {
        return { status: 409, body: { error: (error as Error).message } };
      }
    },
    anchorDiffs(store),
    installs(store, home, { deps: () => storeDeps(store, config, embedder) }),
    machineRoutes(store, paths, { home, platform: process.platform, env: io.env, self: io.self }, (between) =>
      link ? link.sync(between) : between(),
    ),
    async (method, path) => {
      if (path !== "/sync" || method !== "POST") return null;
      if (!link) return { status: 409, body: { error: "this machine is in no team" } };
      const result = await link.sync();
      return result
        ? { status: 200, body: result }
        : { status: 502, body: { error: "the sync failed: the daemon's log says why" } };
    },
    routineRoutes({
      store,
      paths,
      runner,
      storeDeps: () => storeDeps(store, config, embedder),
      team: () => team,
      config: () => rules,
      reloaded: (next) => {
        rules = next;
      },
    }),
  );
  const app = createGateway({
    store,
    config,
    prices,
    port,
    notify,
    runGuard: async (session) => runner.guard(session),
    log: io.err,
    mcp: { files: gitFiles, embedder, resolveRepo: repoResolver(null), me: () => identity(store, config), version },
    admin: {
      token: adminToken(paths.home),
      version,
      identity: { pid: process.pid, port },
      host: {
        storeDeps: () => storeDeps(store, config, embedder),
        team: () => team,
        syncNow: async () => {
          await link?.sync();
        },
        extra,
      },
    },
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

  writeAtomically(infoFile(paths.home), `${JSON.stringify({ pid: process.pid, port, version })}\n`);
  io.err(`grenier ${version} daemon listening on 127.0.0.1:${port} (pid ${process.pid})`);

  link?.start();
  if (team) runner.start();

  const prune = async () => {
    const { usage_days } = config.retention;
    if (usage_days <= 0) return;
    const before = Date.now() - usage_days * DAY;
    try {
      await store.usage.prune(before);
      await store.events.prune(before);
    } catch (error) {
      io.err(`grenier: could not remove old usage: ${(error as Error).message}`);
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
  link?.stop();
  runner.stop();
  clearInterval(pruneTimer);
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
export async function startDaemon(io: Io): Promise<{ pid: number; port: number; version: string; started: boolean }> {
  const { paths } = environment(io);
  const current = await daemonState(paths.home);
  if (current.state === "running" && current.version === version) return { ...current, started: false };
  // One of another version, left running by an update, gives way: nothing else stops it now.
  if (current.state === "running") await stopDaemon(io);

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
    const now = await daemonState(paths.home);
    // Another start may have won the race: its daemon is as good as ours.
    if (now.state === "running") return { ...now, started: now.pid === child.pid };
    if (exited) break;
    await sleep(50);
  }
  const tail = readFileSync(logFile(paths.home), "utf8").trim().split("\n").slice(-5).join("\n");
  throw new CommandError(`the daemon did not start. ${logFile(paths.home)} says:\n${tail}`);
}

/** Stops the daemon; a recorded pid that is another program's is never signalled, only its record removed. */
export async function stopDaemon(io: Io): Promise<{ pid: number | null; stale?: number }> {
  const { paths } = environment(io);
  const current = await daemonState(paths.home);
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
