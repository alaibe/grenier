import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEXTS, type AgentTexts } from "@grenier/gateway";

/** Each text Grenier gives agents: the file in ~/.grenier/instructions with the person's own, and its name in the app. */
export const GRENIER_TEXTS: Record<keyof AgentTexts, { file: string; label: string }> = {
  mcp: { file: "mcp-server.md", label: "MCP server" },
  get: { file: "get.md", label: "get" },
  set: { file: "set.md", label: "set" },
};

export const agentTextPath = (home: string, key: keyof AgentTexts) =>
  join(home, "instructions", GRENIER_TEXTS[key].file);

/** The person's own versions, for the texts they changed; the others stay Grenier's. */
export function agentTexts(home: string): Partial<AgentTexts> {
  const out: Partial<AgentTexts> = {};
  for (const key of Object.keys(AGENT_TEXTS) as (keyof AgentTexts)[]) {
    const path = agentTextPath(home, key);
    const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (text) out[key] = text;
  }
  return out;
}
