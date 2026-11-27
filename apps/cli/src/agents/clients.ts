import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeAtomically } from "@grenier/core/node";
import { acts, READ_TOOLS, type RoutineMode, STORE_TOOLS } from "@grenier/core/routines";
import { Refusal } from "../io.ts";
import { readServers, writeServers } from "./toml.ts";
import type { Agent, AgentCommand, McpClient, ServerEntry, Where } from "./types.ts";

/** Grenier's SessionStart hook's arguments, which also tell it from the person's own hooks. */
const CONTEXT_COMMAND = ["mcp", "context"];

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: unknown; timeout?: number }[];
}

/** A word as a POSIX shell reads it back. */
const quoted = (word: string) => (/^[\w./:=@-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

/** Claude Code's built-in tools that only read. */
const CLAUDE_READS = ["Read", "Grep", "Glob"];

const jsonlFiles = (folder: string): string[] =>
  existsSync(folder)
    ? readdirSync(folder, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(folder, name))
    : [];

/** A skill loaded or an MCP server's tool called, as one transcript line records it, or a call that failed. */
export type ToolEvent =
  | {
      kind: "call";
      id: string | null;
      at: number;
      project: string;
      use: { kind: "skill" | "server"; subject: string; tool: string };
    }
  | { kind: "error"; id: string };

interface ClaudeLine {
  timestamp?: string;
  cwd?: string;
  message?: {
    content?:
      | string
      | {
          type?: string;
          id?: string;
          name?: string;
          input?: { skill?: unknown };
          tool_use_id?: string;
          is_error?: boolean;
        }[];
  };
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A JSON file's object, or an empty one when there is none; refused when it doesn't parse. */
export function readJson(path: string): Record<string, unknown> {
  const text = readText(path);
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Refusal(`${path} is not valid JSON; fix it or move it aside first`);
  }
}

/** The servers a config, or one of its projects, holds under `mcpServers`. */
export function serversIn(config: Record<string, unknown>): Record<string, ServerEntry> {
  const servers = config.mcpServers;
  return servers && typeof servers === "object" ? (servers as Record<string, ServerEntry>) : {};
}

/** A config file in JSON that holds its servers under `mcpServers`, as most MCP apps keep them. */
abstract class JsonClient implements McpClient {
  abstract readonly id: McpClient["id"];
  abstract readonly label: string;
  abstract configPath(where: Where): string;

  protected read(where: Where): Record<string, unknown> {
    return readJson(this.configPath(where));
  }

  /** How this app wants an entry written; most take it as it is. */
  protected shaped(entry: ServerEntry): ServerEntry {
    return entry;
  }

  servers(where: Where): Record<string, ServerEntry> {
    return serversIn(this.read(where));
  }

  editServers(where: Where, change: (servers: Record<string, ServerEntry>) => void): void {
    const config = this.read(where);
    config.mcpServers = this.changed(serversIn(config), change);
    this.write(where, config);
  }

  protected write(where: Where, config: Record<string, unknown>): void {
    writeAtomically(this.configPath(where), `${JSON.stringify(config, null, 2)}\n`);
  }

  /** The servers after a change: only an entry it wrote takes this app's shape; the others stay as they were. */
  protected changed(
    before: Record<string, ServerEntry>,
    change: (servers: Record<string, ServerEntry>) => void,
  ): Record<string, ServerEntry> {
    const servers = { ...before };
    change(servers);
    return Object.fromEntries(
      Object.entries(servers).map(([name, entry]) => [name, entry === before[name] ? entry : this.shaped(entry)]),
    );
  }
}

const program = (path: string) =>
  basename(path)
    .replace(/\.exe$/i, "")
    .toLowerCase();

export class ClaudeCode extends JsonClient implements Agent {
  readonly id = "claude-code";
  readonly label = "Claude Code";
  readonly agent = "claude";

  configPath(where: Where): string {
    return join(where.home, ".claude.json");
  }

  /** Claude Code names each server's transport. */
  protected override shaped(entry: ServerEntry): ServerEntry {
    if (entry.type) return entry;
    return { type: typeof entry.url === "string" ? "http" : "stdio", ...entry };
  }

  /** Each project's own servers, in the same file, by the project's folder. */
  projects(where: Where): Record<string, Record<string, unknown>> {
    const projects = this.read(where).projects;
    return projects && typeof projects === "object" ? (projects as Record<string, Record<string, unknown>>) : {};
  }

  /** Changes one project's servers, keeping the rest of the file. */
  editProject(where: Where, project: string, change: (servers: Record<string, ServerEntry>) => void): void {
    const config = this.read(where);
    const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
    const settings = projects[project];
    if (!settings) throw new Refusal(`Claude Code knows no project ${project}`);
    settings.mcpServers = this.changed(serversIn(settings), change);
    this.write(where, config);
  }

  /** A SessionStart hook running `grenier mcp context`, in place of any Grenier wrote before; other hooks stay. */
  startHook(where: Where, program: string[], env: Record<string, string>): void {
    const path = join(where.home, ".claude", "settings.json");
    const tail = ` ${CONTEXT_COMMAND.join(" ")}`;
    const command = [
      ...Object.entries(env).map(([name, value]) => `${name}=${quoted(value)}`),
      ...[...program, ...CONTEXT_COMMAND].map(quoted),
    ].join(" ");
    const settings = readJson(path);
    const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
    const ours = (group: HookGroup) =>
      (group.hooks ?? []).some((hook) => typeof hook.command === "string" && hook.command.endsWith(tail));
    hooks.SessionStart = [
      ...(hooks.SessionStart ?? []).filter((group) => !ours(group)),
      // A resumed session keeps the context it was given.
      { matcher: "startup|clear|compact", hooks: [{ type: "command", command, timeout: 10 }] },
    ];
    settings.hooks = hooks;
    writeAtomically(path, `${JSON.stringify(settings, null, 2)}\n`);
  }

  present(where: Where): boolean {
    return existsSync(join(where.home, ".claude")) || existsSync(this.configPath(where));
  }

  skillsDir(where: Where): string {
    return join(where.home, ".claude", "skills");
  }

  globalInstructions(where: Where): string {
    return join(where.home, ".claude", "CLAUDE.md");
  }

  isProgram(path: string): boolean {
    return program(path) === "claude";
  }

  ownPrompt(args: readonly string[]): boolean {
    return args.some((arg) => /^--(append-)?system-prompt(-file)?(=|$)/.test(arg));
  }

  runArgs(args: readonly string[], prompt: string | null): string[] {
    return prompt ? ["--append-system-prompt", prompt, ...args] : [...args];
  }

  routine(prompt: string, mode: RoutineMode): AgentCommand {
    // Acting, Claude Code's auto mode judges each call; reading, it gets the reading tools alone.
    const tools = acts(mode)
      ? ["--permission-mode", "auto", "--allowedTools", STORE_TOOLS.join(",")]
      : ["--tools", CLAUDE_READS.join(","), "--allowedTools", [...READ_TOOLS, ...STORE_TOOLS].join(",")];
    return { command: "claude", args: ["-p", prompt, "--output-format", "json", ...tools] };
  }

  transcripts(where: Where): string[] {
    return jsonlFiles(join(where.home, ".claude", "projects"));
  }

  /** The Skill tool and a slash command load a skill, an `mcp__<server>__<tool>` call uses a server; is_error fails. */
  toolEvents(line: string): ToolEvent[] {
    if (!line.includes('"tool_use"') && !line.includes('"is_error":true') && !line.includes("<command-name>"))
      return [];
    let entry: ClaudeLine;
    try {
      entry = JSON.parse(line) as ClaudeLine;
    } catch {
      return [];
    }
    const at = Date.parse(entry.timestamp ?? "");
    if (Number.isNaN(at)) return [];
    const project = entry.cwd ?? "";
    const call = (id: string | null, kind: "skill" | "server", subject: string, tool = ""): ToolEvent[] => [
      { kind: "call", id, at, project, use: { kind, subject, tool } },
    ];
    const content = entry.message?.content;
    if (typeof content === "string") {
      const command = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(content)?.[1];
      return command ? call(null, "skill", command) : [];
    }
    return (content ?? []).flatMap((block): ToolEvent[] => {
      if (block.type === "tool_result" && block.is_error && block.tool_use_id)
        return [{ kind: "error", id: block.tool_use_id }];
      if (block.type !== "tool_use" || !block.name) return [];
      const id = block.id ?? null;
      if (block.name === "Skill" && typeof block.input?.skill === "string") return call(id, "skill", block.input.skill);
      const server = /^mcp__(.+?)__(.+)$/.exec(block.name);
      return server ? call(id, "server", server[1] as string, server[2] as string) : [];
    });
  }
}

export class Codex implements Agent {
  readonly id = "codex";
  readonly label = "Codex";
  readonly agent = "codex";

  #home(where: Where): string {
    return where.env.CODEX_HOME || join(where.home, ".codex");
  }

  configPath(where: Where): string {
    return join(this.#home(where), "config.toml");
  }

  servers(where: Where): Record<string, ServerEntry> {
    return readServers(readText(this.configPath(where)));
  }

  editServers(where: Where, change: (servers: Record<string, ServerEntry>) => void): void {
    const text = readText(this.configPath(where));
    const servers = readServers(text);
    change(servers);
    writeAtomically(this.configPath(where), writeServers(text, servers));
  }

  present(where: Where): boolean {
    return existsSync(this.#home(where));
  }

  skillsDir(where: Where): string {
    return join(this.#home(where), "skills");
  }

  globalInstructions(where: Where): string {
    return join(this.#home(where), "AGENTS.md");
  }

  isProgram(path: string): boolean {
    return program(path) === "codex";
  }

  ownPrompt(args: readonly string[]): boolean {
    return args.some((arg) => /developer_instructions\s*=/.test(arg));
  }

  /** Codex reads its base URL and its instructions only from its config, so each goes in as `-c key=value`. */
  runArgs(args: readonly string[], prompt: string | null, openaiBaseUrl: string): string[] {
    const ownUrl = args.some((arg) => /^openai_base_url\s*=/.test(arg) || /^--config=openai_base_url/.test(arg));
    return [
      ...(prompt ? ["-c", `developer_instructions=${JSON.stringify(prompt)}`] : []),
      ...(ownUrl ? [] : ["-c", `openai_base_url=${JSON.stringify(openaiBaseUrl)}`]),
      ...args,
    ];
  }

  routine(prompt: string, mode: RoutineMode, openaiBaseUrl: string): AgentCommand {
    return {
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        acts(mode) ? "workspace-write" : "read-only",
        "-c",
        `openai_base_url=${JSON.stringify(openaiBaseUrl)}`,
        prompt,
      ],
    };
  }
}

export class Cursor extends JsonClient {
  readonly id = "cursor";
  readonly label = "Cursor";
  configPath(where: Where): string {
    return join(where.home, ".cursor", "mcp.json");
  }
}

export class ClaudeDesktop extends JsonClient {
  readonly id = "claude-desktop";
  readonly label = "Claude Desktop";
  configPath(where: Where): string {
    if (where.platform === "darwin")
      return join(where.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (where.platform === "win32")
      return join(where.env.APPDATA || join(where.home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    return join(where.env.XDG_CONFIG_HOME || join(where.home, ".config"), "Claude", "claude_desktop_config.json");
  }
}
