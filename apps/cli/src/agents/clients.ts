import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeAtomically } from "@grenier/core/node";
import { acts, READ_TOOLS, type RoutineMode, STORE_TOOLS } from "@grenier/core/routines";
import { Refusal } from "../io.ts";
import { readServers, writeServers } from "./toml.ts";
import type { Agent, AgentCommand, McpClient, ServerEntry, Where } from "./types.ts";

/** Claude Code's built-in tools that only read. */
const CLAUDE_READS = ["Read", "Grep", "Glob"];

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A config file in JSON that holds its servers under `mcpServers`, as most MCP apps keep them. */
abstract class JsonClient implements McpClient {
  abstract readonly id: McpClient["id"];
  abstract readonly label: string;
  abstract configPath(where: Where): string;

  protected read(where: Where): Record<string, unknown> {
    const text = readText(this.configPath(where));
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Refusal(`${this.configPath(where)} is not valid JSON; fix it or move it aside first`);
    }
  }

  /** How this app wants an entry written; most take it as it is. */
  protected shaped(entry: ServerEntry): ServerEntry {
    return entry;
  }

  servers(where: Where): Record<string, ServerEntry> {
    const servers = this.read(where).mcpServers;
    return servers && typeof servers === "object" ? (servers as Record<string, ServerEntry>) : {};
  }

  editServers(where: Where, change: (servers: Record<string, ServerEntry>) => void): void {
    const config = this.read(where);
    config.mcpServers = this.changed(this.servers(where), change);
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
    settings.mcpServers = this.changed((settings.mcpServers ?? {}) as Record<string, ServerEntry>, change);
    writeAtomically(this.configPath(where), `${JSON.stringify(config, null, 2)}\n`);
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

  routine(prompt: string, mode: RoutineMode, base: string): AgentCommand {
    return {
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        acts(mode) ? "workspace-write" : "read-only",
        "-c",
        `openai_base_url=${JSON.stringify(`${base}/openai/v1`)}`,
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
