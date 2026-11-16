import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { repoId, repoRoot } from "@grenier/connectors/git";
import { startDaemon } from "../daemon.ts";
import { environment, type Io, UsageError, withStore } from "../io.ts";

export interface RunDependencies {
  startDaemon: (io: Io) => Promise<{ pid: number }>;
}

/** A short random session id, safe in a URL path. */
export function newSessionId(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * `grenier run -- <command>`: registers a session, points the command at the proxy with ANTHROPIC_BASE_URL, runs
 * it, and closes the session when it exits. Returns the command's exit code.
 */
export async function run(argv: string[], io: Io, dependencies: RunDependencies = { startDaemon }): Promise<number> {
  const command = argv[0] === "--" ? argv.slice(1) : argv;
  const [program, ...args] = command;
  if (program === undefined) throw new UsageError("run needs a command, as in: grenier run -- claude");

  const { paths, config } = environment(io);
  await dependencies.startDaemon(io);

  const id = newSessionId();
  const root = await repoRoot(io.cwd);
  const identity = root ? await repoId(root) : null;
  await withStore(paths, (store) =>
    store.sessions.create({
      id,
      client: basename(program),
      cwd: io.cwd,
      repoRoot: root,
      repoId: identity,
      startedAt: Date.now(),
    }),
  );

  const baseUrl = `http://127.0.0.1:${config.proxy.port}/s/${id}`;
  io.err(`grenier: session ${id}, through ${baseUrl}`);

  const code = await new Promise<number>((resolve) => {
    const child = spawn(program, args, {
      stdio: "inherit",
      cwd: io.cwd,
      env: { ...io.env, ANTHROPIC_BASE_URL: baseUrl, OPENAI_BASE_URL: `${baseUrl}/openai/v1` },
    });
    // Ctrl-C reaches the command directly; a second copy from here would make an agent quit instead of interrupting.
    const ignore = () => {};
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onTerm = forward("SIGTERM");
    const onHup = forward("SIGHUP");
    process.on("SIGINT", ignore);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
    const done = (result: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      resolve(result);
    };
    child.once("error", (error) => {
      io.err(
        `grenier: cannot run ${program}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : error.message}`,
      );
      done(127);
    });
    child.once("exit", (exitCode, signal) => done(exitCode ?? 128 + signalNumber(signal)));
  });

  await withStore(paths, (store) => store.sessions.end(id, Date.now()));
  return code;
}

function signalNumber(signal: NodeJS.Signals | null): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return (signal && numbers[signal]) ?? 1;
}
