import { version } from "../package.json";
import { budget } from "./commands/budget.ts";
import { report } from "./commands/report.ts";
import { resume } from "./commands/resume.ts";
import { run as runAgent } from "./commands/run.ts";
import { status } from "./commands/status.ts";
import { runDaemon, startDaemon, stopDaemon } from "./daemon.ts";
import { type Io, isReported, UsageError } from "./io.ts";

export type { Io } from "./io.ts";

const USAGE = `Usage: grenier <command>

Commands:
  status                     Show the config, the database and whether the daemon runs
  start, stop                Start or stop the daemon (the proxy on 127.0.0.1)
  run -- <command>           Run an agent through the proxy as its own session
  report [--by day|session|repo] [--since 7d]
                             Tokens, cache hit rate, cost and savings
  budget                     Show the spending limits
  budget set [--daily <n>] [--session <n>] [--repo <name>=<n>]
                             Set limits in dollars ("off" removes one)
  resume <session>           Let a session paused by the loop guard continue

Options:
  -h, --help                 Show this help
  -v, --version              Show the version`;

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 wrong usage, or the command's own for `run`. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command !== "run" && (rest.includes("-h") || rest.includes("--help"))) {
      io.out(USAGE);
      return 0;
    }
    switch (command) {
      case "-v":
      case "--version":
        io.out(version);
        return 0;
      case undefined:
      case "help":
      case "-h":
      case "--help":
        io.out(USAGE);
        return 0;
      case "status":
        noArguments(command, rest);
        for (const line of await status(io, version)) io.out(line);
        return 0;
      case "start": {
        noArguments(command, rest);
        const { pid, started } = await startDaemon(io);
        io.out(started ? `Daemon started (pid ${pid}).` : `The daemon is already running (pid ${pid}).`);
        return 0;
      }
      case "stop": {
        noArguments(command, rest);
        const pid = await stopDaemon(io);
        io.out(pid === null ? "The daemon is not running." : `Daemon stopped (pid ${pid}).`);
        return 0;
      }
      case "daemon":
        noArguments(command, rest);
        return await runDaemon(io);
      case "run":
        return await runAgent(rest, io);
      case "report":
        io.out(await report(rest, io));
        return 0;
      case "budget":
        for (const line of await budget(rest, io)) io.out(line);
        return 0;
      case "resume":
        io.out(await resume(rest, io));
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.err(`grenier: ${(error as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (isReported(error)) {
      io.err(`grenier: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function noArguments(command: string, rest: string[]): void {
  if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
}

function isParseArgsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code?.startsWith("ERR_PARSE_ARGS") ?? false;
}
