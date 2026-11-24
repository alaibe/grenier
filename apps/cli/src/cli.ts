import { version } from "../package.json";
import { serve } from "./commands/mcp.ts";
import { run as runAgent } from "./commands/run.ts";
import { today } from "./commands/today.ts";
import { runDaemon, stopDaemon } from "./daemon.ts";
import { type Io, isReported, UsageError } from "./io.ts";

const USAGE = `Usage: grenier <command>

Commands:
  run -- <command>           Run an agent through Grenier, which counts what it costs
  mcp serve                  Grenier's MCP server over stdio, as the apps it is added to start it

Options:
  -h, --help                 Show this help
  -v, --version              Show the version`;

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 wrong usage, or the command's own for `run`. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
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
      case "run":
        return await runAgent(rest, io);
      case "mcp":
        if (rest[0] === "serve" && rest.length === 1) return await serve(io);
        throw new UsageError("mcp takes: serve");
      // The app's own: it starts and stops the daemon, and its menu bar shows today's spend.
      case "daemon":
        noArguments(command, rest);
        return await runDaemon(io);
      case "stop":
        noArguments(command, rest);
        await stopDaemon(io);
        return 0;
      case "today":
        noArguments(command, rest);
        io.out(await today(io));
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
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}
