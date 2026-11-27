import { homedir } from "node:os";
import type { Io } from "../io.ts";
import { ClaudeCode, ClaudeDesktop, Codex, Cursor } from "./clients.ts";
import type { Agent, McpClient, Where } from "./types.ts";

export { readJson, serversIn } from "./clients.ts";
export type { Agent, AgentCommand, McpClient, ServerEntry, Where } from "./types.ts";

/** Where this process finds the agents' configs. */
export const whereOf = (io: Pick<Io, "env" | "self">): Where => ({
  home: io.env.HOME || homedir(),
  platform: process.platform,
  env: io.env,
  self: io.self,
});

export const CLAUDE_CODE = new ClaudeCode();
export const CODEX = new Codex();

/** The agents Grenier works with fully, Claude Code first. */
export const AGENTS: readonly Agent[] = [CLAUDE_CODE, CODEX];

/** Every app Grenier's MCP server can be added to. */
export const CLIENTS: readonly McpClient[] = [CLAUDE_CODE, new Cursor(), CODEX, new ClaudeDesktop()];

export type App = McpClient["id"];

export function clientOf(id: string): McpClient | undefined {
  return CLIENTS.find((client) => client.id === id);
}

export const isAgent = (client: McpClient): client is Agent => "skillsDir" in client;

/** A routine's agent by its name, Claude Code unless it says Codex. */
export function agentNamed(name: string): Agent {
  return AGENTS.find((agent) => agent.agent === name) ?? CLAUDE_CODE;
}

/** The agent a command runs, if it runs one. */
export function agentRunning(program: string): Agent | undefined {
  return AGENTS.find((agent) => agent.isProgram(program));
}

/** The agents set up on this machine; Claude Code when none is, as Grenier installs for it first. */
export function presentAgents(where: Where): Agent[] {
  const present = AGENTS.filter((agent) => agent.present(where));
  return present.length > 0 ? present : [CLAUDE_CODE];
}
