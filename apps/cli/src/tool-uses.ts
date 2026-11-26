import { open, stat } from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ToolUsage } from "@grenier/core/api";
import { localDate } from "@grenier/log";
import type { Store, ToolUse } from "@grenier/store";
import { CLAUDE_CODE, type Where } from "./agents/index.ts";

const CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
/** A page opened again within this reads what is counted already. */
const FRESH = 30_000;
export const DAYS = 30;

type Use = Omit<ToolUse, "calls" | "errors" | "lastAt">;

/** A transcript's whole lines from an offset, a chunk at a time, each with the offset after it; the loop runs between. */
async function* chunksOf(path: string, offset: number, size: number, buffer: Buffer) {
  const file = await open(path, "r");
  try {
    let skipping = false;
    for (let start = offset; start < size; ) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - start), start);
      const last = buffer.lastIndexOf(NEWLINE, bytesRead - 1);
      if (last < 0) {
        // A line still being written waits for the next read; one longer than a chunk is skipped.
        if (start + bytesRead >= size) return;
        skipping = true;
        start += bytesRead;
        continue;
      }
      const lines: string[] = [];
      let at = 0;
      if (skipping) {
        at = buffer.indexOf(NEWLINE) + 1;
        skipping = false;
      }
      for (; at <= last; ) {
        const next = buffer.indexOf(NEWLINE, at);
        lines.push(buffer.toString("utf8", at, next));
        at = next + 1;
      }
      start += last + 1;
      yield { lines, end: start };
      await yieldToLoop();
    }
  } finally {
    await file.close();
  }
}

/** Adds what Claude Code's transcripts recorded since they were last read; offsets stop after the last whole line. */
async function readTranscripts(store: Store, where: Where): Promise<void> {
  const rows = new Map<string, ToolUse>();
  const add = (use: Use, calls: number, errors: number, at: number) => {
    const key = JSON.stringify(use);
    const row = rows.get(key) ?? { ...use, calls: 0, errors: 0, lastAt: at };
    row.calls += calls;
    row.errors += errors;
    row.lastAt = Math.max(row.lastAt, at);
    rows.set(key, row);
  };
  const known = await store.toolUses.offsets();
  const moved = new Map<string, number>();
  const buffer = Buffer.allocUnsafe(CHUNK);
  for (const path of CLAUDE_CODE.transcripts(where)) {
    const { size } = await stat(path);
    // A transcript shorter than what was read was written anew.
    const offset = (known.get(path) ?? 0) > size ? 0 : (known.get(path) ?? 0);
    if (offset === size) continue;
    const calls = new Map<string, Use>();
    for await (const { lines, end } of chunksOf(path, offset, size, buffer)) {
      for (const event of lines.flatMap((line) => CLAUDE_CODE.toolEvents(line))) {
        if (event.kind === "error") {
          const use = calls.get(event.id);
          if (use) add(use, 0, 1, 0);
          continue;
        }
        const use = { day: localDate(event.at), agent: CLAUDE_CODE.agent, project: event.project, ...event.use };
        add(use, 1, 0, event.at);
        if (event.id) calls.set(event.id, use);
      }
      moved.set(path, end);
    }
  }
  await store.toolUses.add([...rows.values()], moved);
}

const reads = new WeakMap<Store, { running: Promise<void> | null; at: number }>();

/** Calls made while a read runs wait for it; within FRESH of the last, none is needed. */
export function countToolUses(store: Store, where: Where): Promise<void> {
  const read = reads.get(store) ?? { running: null, at: 0 };
  reads.set(store, read);
  if (!read.running && Date.now() - read.at < FRESH) return Promise.resolve();
  read.running ??= readTranscripts(store, where).finally(() => {
    read.running = null;
    read.at = Date.now();
  });
  return read.running;
}

/** Each of the last DAYS days, oldest first, as `localDate` keys them. */
function lastDays(now: number): string[] {
  return Array.from({ length: DAYS }, (_, back) => {
    const date = new Date(now);
    date.setDate(date.getDate() - (DAYS - 1 - back));
    return localDate(date.getTime());
  });
}

export const sinceDay = (now: number) => lastDays(now)[0] as string;

export function usageOf(rows: readonly ToolUse[], now: number, name: (row: ToolUse) => string): ToolUsage {
  const sum = (key: (row: ToolUse) => string) => {
    const totals = new Map<string, { calls: number; errors: number; lastAt: number }>();
    for (const row of rows) {
      const total = totals.get(key(row)) ?? { calls: 0, errors: 0, lastAt: 0 };
      total.calls += row.calls;
      total.errors += row.errors;
      total.lastAt = Math.max(total.lastAt, row.lastAt);
      totals.set(key(row), total);
    }
    return [...totals].map(([key, total]) => ({ key, ...total })).sort((a, b) => b.calls - a.calls);
  };
  const tools = sum(name);
  const byDay = new Map(sum((row) => row.day).map((day) => [day.key, day]));
  return {
    days: lastDays(now).map((day) => ({ day, calls: byDay.get(day)?.calls ?? 0, errors: byDay.get(day)?.errors ?? 0 })),
    projects: sum((row) => row.project).map(({ key, calls }) => ({ project: key, calls })),
    tools: tools.map(({ key, ...total }) => ({ tool: key, ...total })),
    calls: tools.reduce((total, tool) => total + tool.calls, 0),
    errors: tools.reduce((total, tool) => total + tool.errors, 0),
    lastAt: Math.max(0, ...tools.map((tool) => tool.lastAt)) || null,
  };
}
