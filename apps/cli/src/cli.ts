import { version } from "../package.json";
import { ask, promptHook } from "./commands/ask.ts";
import { doctor } from "./commands/doctor.ts";
import { key } from "./commands/key.ts";
import { install, serve } from "./commands/mcp.ts";
import { audit, clients } from "./commands/personal.ts";
import { report } from "./commands/report.ts";
import { resume } from "./commands/resume.ts";
import { machine, routines } from "./commands/routines.ts";
import { run as runAgent } from "./commands/run.ts";
import { sharedCommand, shareServer } from "./commands/skills.ts";
import { status } from "./commands/status.ts";
import { statusline } from "./commands/statusline.ts";
import { storeCommand } from "./commands/store.ts";
import { team } from "./commands/team.ts";
import { runDaemon, startDaemon, stopDaemon } from "./daemon.ts";
import { type Io, isReported, UsageError } from "./io.ts";

const USAGE = `Usage: grenier <command>

Commands:
  status                     Show the config, the database and whether the daemon runs
  doctor                     Check the daemon, the AI tools' configs, the hook and the team store
  start, stop                Start or stop the daemon (the proxy on 127.0.0.1)
  run -- <command>           Run an agent through the proxy as its own session
  report [--by day|session|repo] [--since 7d] [--json]
                             Tokens, cache hit rate, cost and savings
  report --cache [--since 7d]
                             Prompt-cache writes and reads by session, flagging churn
  report --effectiveness [--since 30d]
                             What the spend turned into: landed share, rediscovery, cost per issue
  statusline [--today]       One line for Claude Code's status line: what this session and today spent and cached
  resume <session>           Let a session paused by the loop guard continue
  mcp install <claude-code|cursor|codex|claude-desktop> [--scope <spaces>] [--hook]
                             Add Grenier's MCP server to that client's config, with a client token;
                             --hook also passes Claude Code a recorded answer close to each prompt
  mcp serve                  The MCP server over stdio (what the clients launch)
  mcp share <name>           Share one of your Claude Code MCP servers with the team, without its credentials
  ask [--repo <path>] [--json] <question>
                             What the store holds for a question
  store [list] [--type <type>] [--space <space>] [--retired], store show <id>, store stats
                             The records on this machine
  store add <type> <title> [--body "…" | --body-file <path>] [--field name=value] [--space <space>]
                             Write a record; store retire <id> retires one
  store clear [--repo <path>]
                             Remove a repository's records from this machine (the team store keeps them);
                             the current directory's by default
  team deploy [--name grenier-team] [--member <name>]
                             Put the team store in your Cloudflare account (after npx wrangler login), as its admin
  team join <link>           Join a team from an invite link, then confirm the code with its admin
  team invite <name> [--admin], team pending, team confirm <code>
                             Invite someone (admins): a link, then the six-digit code their screen shows
  team members, team role <name> admin|member, team remove <name>
  team machines, team rename <name>
                             The team's machines and their state; rename this one
  team spaces [add <name> [--members a,b]]
  team web                   A one-time link that signs a browser in to the web view
  team webhook <routine>     An address another tool can call to file requests for a routine (admins)
  team status, team sync     The team connection; sync now (the daemon syncs on its own)
  key, key set <key>         Your personal key for the encrypted \`me\` space; put the same on your other machines
  skills [list], skills share <folder>, skills install|remove|rollback <id>, skills auto on|off
                             The team's skills, installed into Claude Code once approved;
                             auto on installs and updates the ones an admin recommends
  servers [list], servers install|remove|rollback <id>
                             The team's MCP servers, installed into Claude Code once approved
  routines [list], routines on|off, routines add <file.md> [--repo <path>] [--space <space>]
  routines approve <id> [--mode read-only|shadow|limited|on] [--limit <actions a day>]
  routines run <id> [--version <n>] [--task "…"], routines eval <id> [--version <n>], routines promote <id> <n>
  routines workflow <id> [--file <path>], routines librarian
                             The team's routines, run on idle machines that opted in; workflow prints and approves
                             the GitHub workflow that runs one on a Grenier runner; librarian adds the
                             built-in routine that suggests fixes to the store each day
  machine, machine set <rule> <value>
                             This machine's state and the rules that keep routines from disturbing you
  clients add <name> [--scope <spaces>], clients [list], clients revoke <name>
                             Tokens for agents and apps that use the store over MCP
  audit [--client <name>] [--since 7d]
                             Every read a client made of the store

Options:
  -h, --help                 Show this help
  -v, --version              Show the version`;

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 wrong usage, or the command's own for `run`. */
export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const topic = command === "help" ? rest[0] : asksHelp(command, rest) ? command : undefined;
    if (topic !== undefined) {
      const own = commandHelp(topic);
      if (!own && command === "help") throw new UsageError(`unknown command "${topic}"`);
      io.out(own ?? USAGE);
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
      case "doctor": {
        noArguments(command, rest);
        const { lines, code } = await doctor(io);
        for (const line of lines) io.out(line);
        return code;
      }
      case "start": {
        noArguments(command, rest);
        const { pid, started } = await startDaemon(io);
        io.out(started ? `Daemon started (pid ${pid}).` : `The daemon is already running (pid ${pid}).`);
        return 0;
      }
      case "stop": {
        noArguments(command, rest);
        const { pid, stale } = await stopDaemon(io);
        if (stale !== undefined) {
          io.out(
            `The daemon is not running. Its record named pid ${stale}, now another program's: left alone, record removed.`,
          );
        } else {
          io.out(pid === null ? "The daemon is not running." : `Daemon stopped (pid ${pid}).`);
        }
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
      case "resume":
        io.out(await resume(rest, io));
        return 0;
      case "mcp":
        if (rest[0] === "serve" && rest.length === 1) return await serve(io);
        if (rest[0] === "share") {
          for (const line of await shareServer(rest.slice(1), io)) io.out(line);
          return 0;
        }
        if (rest[0] === "install") {
          io.out(await install(rest.slice(1), io));
          return 0;
        }
        throw new UsageError("mcp takes: install <client>, share <name>, or serve");
      case "ask":
        io.out(await ask(rest, io));
        return 0;
      case "hook":
        if (rest[0] === "prompt" && rest.length === 1) return await promptHook(io);
        throw new UsageError("hook takes: prompt (Claude Code's UserPromptSubmit hook)");
      case "store":
        for (const line of await storeCommand(rest, io)) io.out(line);
        return 0;
      case "key":
        for (const line of await key(rest, io)) io.out(line);
        return 0;
      case "team":
        for (const line of await team(rest, io)) io.out(line);
        return 0;
      case "routines":
        for (const line of await routines(rest, io)) io.out(line);
        return 0;
      case "machine":
        for (const line of await machine(rest, io)) io.out(line);
        return 0;
      case "skills":
        for (const line of await sharedCommand("Skill", rest, io)) io.out(line);
        return 0;
      case "servers":
        for (const line of await sharedCommand("McpServer", rest, io)) io.out(line);
        return 0;
      case "clients":
        for (const line of await clients(rest, io)) io.out(line);
        return 0;
      case "audit":
        for (const line of await audit(rest, io)) io.out(line);
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      const help = (command && commandHelp(command)) || USAGE;
      io.err(`grenier: ${(error as Error).message}\n\n${help}`);
      return 2;
    }
    if (isReported(error)) {
      io.err(`grenier: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** `-h` or `--help` anywhere, or `help` first; never for `run`, and `ask` takes `help` as a word. */
function asksHelp(command: string | undefined, rest: string[]): boolean {
  if (command === undefined || command === "run") return false;
  return rest.includes("-h") || rest.includes("--help") || (command !== "ask" && rest[0] === "help");
}

/** The usage lines of one command, those naming it and the lines that continue them, or undefined for no command. */
function commandHelp(command: string): string | undefined {
  const lines: string[] = [];
  let taking = false;
  for (const line of USAGE.split("\n")) {
    if (/^ {2}\S/.test(line)) {
      const synopsis = line.trim().split(/ {2,}/)[0] ?? "";
      taking = synopsis.split(", ").some((part) => part.split(" ")[0] === command);
    } else if (!/^ {29}\S/.test(line)) taking = false;
    if (taking) lines.push(line);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n\nEvery command: grenier --help` : undefined;
}

function noArguments(command: string, rest: string[]): void {
  if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
}

function isParseArgsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}
