import { version } from "../package.json";
import { budget } from "./commands/budget.ts";
import { cache } from "./commands/cache.ts";
import { install, serve } from "./commands/mcp.ts";
import { report } from "./commands/report.ts";
import { resume } from "./commands/resume.ts";
import { run as runAgent } from "./commands/run.ts";
import { status } from "./commands/status.ts";
import { team } from "./commands/team.ts";
import { runDaemon, startDaemon, stopDaemon } from "./daemon.ts";
import { type Io, isReported, UsageError } from "./io.ts";

export type { Io } from "./io.ts";

const USAGE = `Usage: grenier <command>

Commands:
  status                     Show the config, the database and whether the daemon runs
  start, stop                Start or stop the daemon (the proxy on 127.0.0.1)
  run -- <command>           Run an agent through the proxy as its own session
  report [--by day|session|repo] [--since 7d] [--json]
                             Tokens, cache hit rate, cost and savings
  report --cache [--since 7d]
                             Prompt-cache writes and reads by session, flagging churn
  budget                     Show the spending limits
  budget set [--daily <n>] [--session <n>] [--repo <name>=<n>]
                             Set limits in dollars ("off" removes one)
  resume <session>           Let a session paused by the loop guard continue
  mcp install <claude-code|cursor|codex|claude-desktop>
                             Add Grenier's MCP server to that client's config
  mcp serve                  The MCP server over stdio (what the clients launch)
  cache stats                Answers and summaries kept, by repository
  cache clear [--repo <name>]
                             Empty the cache, or one repository's part of it
  team deploy [--name grenier-team] [--admin <name>]
                             Deploy the team server to your Cloudflare account (after npx wrangler login)
  team join <url> <token>    Connect this machine to a team server
  team invite <name> [--admin]
                             Create a teammate's token (admins)
  team share [--repo <path>], team unshare [--repo <path>]
                             Share a repository's answers and summaries with the team, or stop
  team status, team sync     The team connection; sync now (the daemon syncs on its own)
  team budget [--team <n>] [--member <n>]
                             Team-wide and per-member daily limits in dollars (admins set them)

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
      case "mcp":
        if (rest[0] === "serve" && rest.length === 1) return await serve(io);
        if (rest[0] === "install") {
          io.out(install(rest.slice(1), io));
          return 0;
        }
        throw new UsageError("mcp takes: install <client>, or serve");
      case "cache":
        for (const line of await cache(rest, io)) io.out(line);
        return 0;
      case "team":
        for (const line of await team(rest, io)) io.out(line);
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
