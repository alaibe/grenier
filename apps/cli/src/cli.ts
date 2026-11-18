import { version } from "../package.json";
import { ask, promptHook } from "./commands/ask.ts";
import { budget } from "./commands/budget.ts";
import { cache } from "./commands/cache.ts";
import { install, serve } from "./commands/mcp.ts";
import { audit, clients, review, sources } from "./commands/personal.ts";
import { report } from "./commands/report.ts";
import { resume } from "./commands/resume.ts";
import { run as runAgent } from "./commands/run.ts";
import { status } from "./commands/status.ts";
import { statusline } from "./commands/statusline.ts";
import { team } from "./commands/team.ts";
import { vault } from "./commands/vault.ts";
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
  statusline [--today]       One line for Claude Code's status line: what this session and today spent and saved
  budget                     Show the spending limits
  budget set [--daily <n>] [--session <n>] [--repo <name>=<n>]
                             Set limits in dollars ("off" removes one)
  resume <session>           Let a session paused by the loop guard continue
  mcp install <claude-code|cursor|codex|claude-desktop> [--scope <sources or kinds>] [--hook]
                             Add Grenier's MCP server to that client's config, with a client token;
                             --hook also passes Claude Code a recorded answer close to each prompt
  mcp serve                  The MCP server over stdio (what the clients launch)
  ask [--repo <path>] [--json] <question>
                             What the exploration cache holds for a question
  cache stats                Answers and summaries kept, by repository
  cache forget <id>          Remove one answer, from the team's cache too when it was shared
  cache clear [--repo <name>]
                             Empty the cache, or one repository's part of it
  team deploy [--name grenier-team] [--admin <name>]
                             Deploy the team server to your Cloudflare account (after npx wrangler login,
                             with R2 turned on)
  team join <url> <token>    Connect this machine to a team server
  team invite <name> [--admin]
                             Create a teammate's token (admins)
  team share [--repo <path>], team unshare [--repo <path>]
                             Share a repository's answers and summaries with the team, or stop
  team status, team sync     The team connection; sync now (the daemon syncs on its own)
  team budget [--team <n>] [--member <n>]
                             Team-wide and per-member daily limits in dollars (admins set them)
  sources add <markdown|ics|caldav|imap> <name> <path, url or host> [--user …] [--password-command "…"]
                             Add a personal-data source (passwords come from a command or an env var)
  sources [list], sources sync [name], sources remove <name>
  clients add <name> --scope <sources or kinds>
                             A token for an app that reads personal data (kinds: notes, mail, calendar, memory)
  clients [list], clients revoke <name>
  audit [--client <name>] [--since 7d]
                             Every read of personal data
  review, review approve <id>, review reject <id>
                             Memories AI tools proposed with remember
  vault init, vault join <key>, vault key, vault share <source>, vault unshare <source>, vault sync
                             End-to-end encrypted sync, between your devices, of the sources you share

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
      case "statusline":
        io.out(await statusline(rest, io));
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
          io.out(await install(rest.slice(1), io));
          return 0;
        }
        throw new UsageError("mcp takes: install <client>, or serve");
      case "ask":
        io.out(await ask(rest, io));
        return 0;
      case "hook":
        if (rest[0] === "prompt" && rest.length === 1) return await promptHook(io);
        throw new UsageError("hook takes: prompt (Claude Code's UserPromptSubmit hook)");
      case "cache":
        for (const line of await cache(rest, io)) io.out(line);
        return 0;
      case "team":
        for (const line of await team(rest, io)) io.out(line);
        return 0;
      case "sources":
        for (const line of await sources(rest, io)) io.out(line);
        return 0;
      case "clients":
        for (const line of await clients(rest, io)) io.out(line);
        return 0;
      case "audit":
        for (const line of await audit(rest, io)) io.out(line);
        return 0;
      case "review":
        for (const line of await review(rest, io)) io.out(line);
        return 0;
      case "vault":
        for (const line of await vault(rest, io)) io.out(line);
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
