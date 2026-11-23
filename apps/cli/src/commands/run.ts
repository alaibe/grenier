import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { repoId, repoRoot } from "@grenier/connectors/git";
import { ASK_FIRST } from "@grenier/gateway";
import { version } from "../../package.json";
import { startDaemon } from "../daemon.ts";
import { environment, type Io, UsageError, withStore } from "../io.ts";

export interface RunDependencies {
  startDaemon: (io: Io) => Promise<{ pid: number; port?: number; version?: string | null }>;
}

/** A short random session id, safe in a URL path. */
export function newSessionId(): string {
  return randomBytes(9).toString("base64url");
}

export const ASKED_FIRST =
  "grenier: asked Claude Code to call recall before exploring (--append-system-prompt; pass your own to skip it)";

const SYSTEM_PROMPT_FLAG = /^--(append-)?system-prompt(-file)?(=|$)/;

/** Whether Claude Code gets ASK_FIRST: in a repository, unless the command gives its own system prompt. */
export function asksFirst(program: string, args: readonly string[], inRepository: boolean): boolean {
  return (
    inRepository && /^claude(\.exe)?$/i.test(basename(program)) && !args.some((arg) => SYSTEM_PROMPT_FLAG.test(arg))
  );
}

/**
 * The command's arguments, plus what points it at the proxy when an environment variable cannot: Codex reads its base
 * URL only from its config, so it gets `-c openai_base_url=…` unless the command already sets one. With `askFirst`,
 * Claude Code gets ASK_FIRST in its system prompt.
 */
export function agentArgs(
  program: string,
  args: readonly string[],
  openaiBaseUrl: string,
  askFirst: boolean,
): string[] {
  if (askFirst) return ["--append-system-prompt", ASK_FIRST, ...args];
  const codex = /^codex(\.exe)?$/i.test(basename(program));
  if (!codex || args.some((arg) => /^openai_base_url\s*=/.test(arg) || /^--config=openai_base_url/.test(arg))) {
    return [...args];
  }
  return ["-c", `openai_base_url=${JSON.stringify(openaiBaseUrl)}`, ...args];
}

/**
 * `grenier run -- <command>`: registers a session, points the command at the proxy (ANTHROPIC_BASE_URL,
 * OPENAI_BASE_URL, and Codex's own setting), runs it with the session's id in GRENIER_SESSION, and closes the session
 * when it exits. Returns the command's exit code.
 */
export async function run(argv: string[], io: Io, dependencies: RunDependencies = { startDaemon }): Promise<number> {
  const command = argv[0] === "--" ? argv.slice(1) : argv;
  const [program, ...args] = command;
  if (program === undefined) throw new UsageError("run needs a command, as in: grenier run -- claude");

  const { paths, config } = environment(io);
  const daemon = await dependencies.startDaemon(io);
  if (daemon.version && daemon.version !== version) {
    io.err(
      `grenier: the daemon runs ${daemon.version}, this command is ${version}; to update it: grenier stop && grenier start`,
    );
  }

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

  const baseUrl = `http://127.0.0.1:${daemon.port ?? config.proxy.port}/s/${id}`;
  const openaiBaseUrl = `${baseUrl}/openai/v1`;
  const askFirst = asksFirst(program, args, root !== null);
  io.err(`grenier: session ${id}, through ${baseUrl}`);
  if (askFirst) io.err(ASKED_FIRST);

  const code = await new Promise<number>((resolve) => {
    const child = spawn(program, agentArgs(program, args, openaiBaseUrl, askFirst), {
      stdio: "inherit",
      cwd: io.cwd,
      env: { ...io.env, ANTHROPIC_BASE_URL: baseUrl, OPENAI_BASE_URL: openaiBaseUrl, GRENIER_SESSION: id },
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
