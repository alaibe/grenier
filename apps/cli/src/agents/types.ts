import type { RoutineMode } from "@grenier/core/routines";

export interface Where {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** How this Grenier runs, so the app it is added to starts the same one. */
  self: string[];
}

/** An MCP server as an app's config holds it, in Claude Code's shape: a command, or a URL with headers. */
export type ServerEntry = Record<string, unknown> & {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
};

/** An app that starts MCP servers: Claude Code, Codex, Cursor, Claude Desktop. */
export interface McpClient {
  readonly id: "claude-code" | "codex" | "cursor" | "claude-desktop";
  /** Its name, as its own window shows it. */
  readonly label: string;
  configPath(where: Where): string;
  /** Its servers for every project, by name. */
  servers(where: Where): Record<string, ServerEntry>;
  /** Changes its servers in place, keeping the rest of its config as it was. */
  editServers(where: Where, change: (servers: Record<string, ServerEntry>) => void): void;
}

/** What a routine's run starts. */
export interface AgentCommand {
  command: string;
  args: string[];
}

/** An agent Grenier works with fully: its MCP servers, its skills, its instructions, `grenier run` and routines. */
export interface Agent extends McpClient {
  /** As a routine names it. */
  readonly agent: "claude" | "codex";
  /** Whether it is set up on this machine. */
  present(where: Where): boolean;
  skillsDir(where: Where): string;
  /** The instructions file every project gets. */
  globalInstructions(where: Where): string;
  /** Whether `grenier run` starts it, by the program's name. */
  isProgram(program: string): boolean;
  /** Whether the command already gives its own system prompt, so Grenier's is left out. */
  ownPrompt(args: readonly string[]): boolean;
  /** `grenier run`'s arguments: Grenier's prompt when given, and the proxy where only a flag can set it. */
  runArgs(args: readonly string[], prompt: string | null, openaiBaseUrl: string): string[];
  /** A routine's run, read-only or acting as its mode says, through the proxy at `base`. */
  routine(prompt: string, mode: RoutineMode, base: string): AgentCommand;
}
