import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createGateway } from "@grenier/gateway";
import { loadPrices } from "@grenier/log";
import { openSqliteStore } from "@grenier/store/sqlite";
import { serve } from "@hono/node-server";
import { version } from "../package.json";
import { CommandError, environment, type Io } from "./io.ts";
import { desktopNotifier } from "./notify.ts";

/** The daemon writes its pid here while it runs. */
export function pidFile(home: string): string {
  return join(home, "daemon.pid");
}

export function logFile(home: string): string {
  return join(home, "daemon.log");
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
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

/** `grenier daemon`: serves the proxy in the foreground until SIGTERM or SIGINT. */
export async function runDaemon(io: Io): Promise<number> {
  const { paths, config } = environment(io);
  const running = daemonPid(paths.home);
  if (running !== null) throw new CommandError(`the daemon is already running (pid ${running})`);

  const store = openSqliteStore(paths.db);
  const port = config.proxy.port;
  const app = createGateway({
    store,
    config,
    prices: loadPrices(config.prices),
    port,
    notify: desktopNotifier(io.err),
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

  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
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
  for (let waited = 0; waited < 10_000; waited += 50) {
    if (!isAlive(pid)) return pid;
    await sleep(50);
  }
  throw new CommandError(`the daemon (pid ${pid}) did not stop; see ${logFile(paths.home)}`);
}
