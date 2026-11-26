import { spawn } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";
import { AGENT_TEXTS } from "@grenier/gateway";
import { repoId, repoRoot } from "@grenier/git";
import { agentTexts } from "../agent-texts.ts";
import { type Agent, agentRunning } from "../agents/index.ts";
import { startDaemon } from "../daemon.ts";
import { environment, type Io, UsageError, withStore } from "../io.ts";
import { newSessionId, sessionProxy } from "../runtime.ts";

export interface RunDependencies {
  startDaemon: (io: Io) => Promise<{ pid: number; port?: number; version?: string }>;
}

/** Whether an agent gets Grenier's prompt: in a repository, unless the command gives its own. */
export function asksFirst(agent: Agent | undefined, args: readonly string[], inRepository: boolean): boolean {
  return Boolean(inRepository && agent && !agent.ownPrompt(args));
}

/** `grenier run -- <command>`: runs the command through the proxy, in a session of its own. */
export async function run(argv: string[], io: Io, dependencies: RunDependencies = { startDaemon }): Promise<number> {
  const command = argv[0] === "--" ? argv.slice(1) : argv;
  const [program, ...args] = command;
  if (program === undefined) throw new UsageError("run needs a command, as in: grenier run -- claude");

  const { paths, config } = environment(io);
  const daemon = await dependencies.startDaemon(io);

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

  const proxy = sessionProxy(daemon.port ?? config.proxy.port, id);
  const agent = agentRunning(program);
  const askFirst = asksFirst(agent, args, root !== null);
  io.err(`grenier: session ${id}, through ${proxy.base}`);
  if (agent && askFirst) {
    io.err(`grenier: asked ${agent.label} to call get before exploring (pass your own system prompt to skip it)`);
  }

  const code = await new Promise<number>((resolve) => {
    const prompt = askFirst ? (agentTexts(paths.home).mcp ?? AGENT_TEXTS.mcp) : null;
    const command = agent ? agent.runArgs(args, prompt, proxy.openai) : args;
    const child = spawn(program, command, { stdio: "inherit", cwd: io.cwd, env: { ...io.env, ...proxy.env } });
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
    child.once("exit", (exitCode, signal) => done(exitCode ?? 128 + (signal ? constants.signals[signal] : 1)));
  });

  await withStore(paths, (store) => store.sessions.end(id, Date.now()));
  return code;
}
