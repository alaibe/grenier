import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEXTS, type AgentTexts } from "@grenier/gateway";

/** Each text Grenier gives agents, by the file in ~/.grenier/instructions that holds the person's own version. */
export const AGENT_TEXT_FILES: Record<keyof AgentTexts, string> = {
  run: "grenier-run.md",
  mcp: "mcp-server.md",
  get: "get.md",
  set: "set.md",
};

export const agentTextPath = (home: string, key: keyof AgentTexts) => join(home, "instructions", AGENT_TEXT_FILES[key]);

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
