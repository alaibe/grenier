import { sha256 } from "./policy.ts";
import type { ROUTINE_MODES } from "./records.ts";

export type RoutineMode = (typeof ROUTINE_MODES)[number];

/** Claude Code's tools that only read. */
export const READ_TOOLS = ["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite"] as const;

/** Grenier's own tools: a run reads the store and writes its output there. */
export const STORE_TOOLS = ["mcp__grenier__get", "mcp__grenier__set"] as const;

/** An MCP tool whose name says it only reads: list_, get_, search_ and the like. */
export function readsByName(tool: string): boolean {
  if (!tool.startsWith("mcp__")) return false;
  const name = tool.split("__").at(-1) ?? "";
  return /^(get|list|search|read|fetch|query|find|view|show)(_|[A-Z]|$)/.test(name);
}

/** Codex's patch tool, which its read-only sandbox does not hold back. */
const CODEX_PATCH = "apply_patch";

/** Codex's own tools (its shell, its plan), which its sandbox holds to the mode rather than the list. */
function sandboxed(agent: string, tool: string): boolean {
  return agent === "codex" && tool !== CODEX_PATCH && !tool.startsWith("mcp__");
}

/** Whether a mode lets a run act: then Claude Code's auto mode, or Codex's sandbox, judges each call. */
export function acts(mode: RoutineMode): boolean {
  return mode === "limited" || mode === "on";
}

/** Whether a tool call only reads: the reading tools, the store's, and Codex's sandboxed ones. */
function reads(agent: string, tool: string): boolean {
  return (
    (READ_TOOLS as readonly string[]).includes(tool) ||
    (STORE_TOOLS as readonly string[]).includes(tool) ||
    readsByName(tool) ||
    sandboxed(agent, tool)
  );
}

/** Whether a run may call a tool: anything once it acts, else what only reads. */
export function mayCall(agent: string, mode: RoutineMode, tool: string): boolean {
  return acts(mode) || reads(agent, tool);
}

/** Whether a tool call counts as an action, against `limited`'s daily allowance; Codex reads with its shell too. */
export function isAction(tool: string, agent = "claude"): boolean {
  return !reads(agent, tool);
}

export interface RoutineShape {
  body: string;
  fields: Record<string, unknown>;
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
      agent: fields.agent ?? "claude",
      collector: fields.collector ?? "no",
      owner: fields.collector === "yes" ? (fields.owner ?? "") : "",
    }),
  );
}

/** A routine's run to do, from its schedule: a task in the routine's top folder, which names the routine and links to it. */
export function taskFor(routine: { id: string; top: string }, title: string, body: string) {
  return {
    top: routine.top,
    type: "Task",
    title,
    body,
    fields: { status: "to-do", routine: routine.id },
    links: [{ kind: "record" as const, ref: routine.id }],
  };
}

/** What an approval of a shared skill or MCP server pins: the hash of exactly what gets installed. */
export async function sharedHash(record: { type: string; fields: Record<string, unknown> }): Promise<string> {
  const value =
    record.type === "Skill"
      ? record.fields.files
      : { config: record.fields.config ?? null, credentials: record.fields.credentials ?? [] };
  const entries =
    value && typeof value === "object" ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b)) : [];
  return sha256(JSON.stringify(entries));
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
