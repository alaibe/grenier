import { sha256 } from "./policy.ts";
import type { ROUTINE_MODES } from "./records.ts";

export type RoutineMode = (typeof ROUTINE_MODES)[number];

/** Claude Code's tools that only read. */
export const READ_TOOLS = ["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"] as const;

/** Grenier's own tools: a run reads the store and writes its output there. */
export const STORE_TOOLS = [
  "mcp__grenier__recall",
  "mcp__grenier__query",
  "mcp__grenier__remember",
  "mcp__grenier__file_summary",
  "mcp__grenier__repo_map",
] as const;

/** An MCP tool whose name says it only reads: list_, get_, search_ and the like. */
export function readsByName(tool: string): boolean {
  if (!tool.startsWith("mcp__")) return false;
  const name = tool.split("__").at(-1) ?? "";
  return /^(get|list|search|read|fetch|query|find|view|show)(_|[A-Z]|$)/.test(name);
}

/** What a run may call in a mode: reading always; the routine's other tools only once its machine lets it act. */
export function allowedTools(mode: RoutineMode, routineTools: readonly string[]): string[] {
  const reads = routineTools.filter(readsByName);
  const acts = mode === "limited" || mode === "on" ? routineTools : [];
  return [...new Set([...READ_TOOLS, ...STORE_TOOLS, ...reads, ...acts])];
}

/** Whether a tool call counts as an action, against `limited`'s daily allowance. */
export function isAction(tool: string): boolean {
  return (
    !(READ_TOOLS as readonly string[]).includes(tool) &&
    !(STORE_TOOLS as readonly string[]).includes(tool) &&
    !readsByName(tool)
  );
}

export interface RoutineShape {
  body: string;
  fields: Record<string, unknown>;
}

export function toolsOf(routine: RoutineShape): string[] {
  return Array.isArray(routine.fields.tools) ? routine.fields.tools.map(String) : [];
}

/** Whether the routine says what to do: the page's text is its prompt, which a run cannot do without. */
export function hasPrompt(routine: RoutineShape): boolean {
  return routine.body.trim() !== "";
}

/** What a machine's person approves: any change to these fields waits for their approval again. */
export async function routineHash(routine: RoutineShape): Promise<string> {
  const { fields } = routine;
  return sha256(
    JSON.stringify({
      prompt: routine.body,
      tools: toolsOf(routine),
      repo: fields.repo ?? "",
      agent: fields.agent ?? "claude",
      collector: fields.collector ?? "no",
      owner: fields.collector === "yes" ? (fields.owner ?? "") : "",
    }),
  );
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** When a schedule ("hourly", "daily 09:00", "weekdays 09:00", "mon 09:00") next falls, in UTC; null if unreadable. */
export function nextDue(schedule: string, after: number): number | null {
  const text = schedule.trim().toLowerCase();
  if (text === "hourly") return (Math.floor(after / 3_600_000) + 1) * 3_600_000;
  const match = /^(daily|weekdays|sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  const start = new Date(after);
  for (let day = 0; day <= 7; day++) {
    const at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + day, hour, minute);
    if (at <= after) continue;
    const weekday = new Date(at).getUTCDay();
    if (match[1] === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (match[1] !== "daily" && match[1] !== "weekdays" && DAYS[weekday] !== match[1]) continue;
    return at;
  }
  return null;
}
