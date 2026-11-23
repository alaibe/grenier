import type { UsageWithSession } from "@grenier/store";
import { cacheSavingsOf, type Prices } from "./cost.ts";

export type GroupBy = "day" | "session" | "repo";

export interface ReportRow {
  key: string;
  requests: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** USD; requests to a model with no price count as 0 and are counted in `unpriced`. */
  cost: number;
  unpriced: number;
  /** USD saved by prompt-cache reads. */
  saved: number;
}

/** Share of input tokens served from the prompt cache. */
export function cacheHitRate(row: Pick<ReportRow, "inputTokens" | "cacheWriteTokens" | "cacheReadTokens">): number {
  const input = row.inputTokens + row.cacheWriteTokens + row.cacheReadTokens;
  return input === 0 ? 0 : row.cacheReadTokens / input;
}

/** Totals per day (local time), session or repository, in the order each key first appears. */
export function buildReport(rows: readonly UsageWithSession[], by: GroupBy, prices: Prices): ReportRow[] {
  const groups = new Map<string, ReportRow>();
  for (const row of rows) {
    const key = keyOf(row, by);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        requests: 0,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        cost: 0,
        unpriced: 0,
        saved: 0,
      };
      groups.set(key, group);
    }
    group.requests += 1;
    group.inputTokens += row.inputTokens ?? 0;
    group.cacheWriteTokens += row.cacheWriteTokens ?? 0;
    group.cacheReadTokens += row.cacheReadTokens ?? 0;
    group.outputTokens += row.outputTokens ?? 0;
    if (row.cost === null) group.unpriced += 1;
    else group.cost += row.cost;
    group.saved += cacheSavingsOf(row.model, row.cacheReadTokens ?? 0, prices);
  }
  return [...groups.values()];
}

function keyOf(row: UsageWithSession, by: GroupBy): string {
  switch (by) {
    case "day":
      return localDate(row.ts);
    case "session":
      return row.sessionId;
    case "repo":
      return projectOf(row) ?? NO_PROJECT;
  }
}

const NO_PROJECT = "(not started with grenier run)";

/** The last segment of a path, or the path itself for a root such as `/`. */
export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}

/**
 * The project a session's spending is grouped under, everywhere (reports, the dashboard, the menu bar):
 * the folder name of its repository, else of the folder it started in; null for neither.
 */
export function projectOf(session: { repoRoot: string | null; cwd: string | null }): string | null {
  const folder = session.repoRoot ?? session.cwd;
  return folder ? folderName(folder) : null;
}

function localDate(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Midnight today in local time, in Unix milliseconds. */
export function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Reads `7d`, `12h`, `30m` or a date (`2026-11-01`) as a start time. Throws on anything else. */
export function parseSince(value: string, now: number): number {
  const relative = /^(\d+)([dhm])$/.exec(value);
  if (relative) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[relative[2] as "d" | "h" | "m"];
    return now - Number(relative[1]) * unit;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    return new Date(year, month - 1, day).getTime();
  }
  throw new Error(`--since takes a duration such as 7d, 12h or 30m, or a date such as 2026-11-01, not "${value}"`);
}

const COLUMNS = ["", "requests", "input", "cache write", "cache read", "output", "cache hit", "cost", "saved"];

/** The sum of report rows, as one row with the key "total". */
export function totalOf(rows: readonly ReportRow[]): ReportRow {
  return rows.reduce<ReportRow>(
    (sum, row) => ({
      key: "total",
      requests: sum.requests + row.requests,
      inputTokens: sum.inputTokens + row.inputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cost: sum.cost + row.cost,
      unpriced: sum.unpriced + row.unpriced,
      saved: sum.saved + row.saved,
    }),
    {
      key: "total",
      requests: 0,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      unpriced: 0,
      saved: 0,
    },
  );
}

/** A plain-text table of report rows with a total line. */
export function formatReport(rows: readonly ReportRow[]): string {
  if (rows.length === 0) return "No requests in this period.";

  const total = totalOf(rows);
  const cells = (row: ReportRow) => [
    row.key,
    String(row.requests),
    tokens(row.inputTokens),
    tokens(row.cacheWriteTokens),
    tokens(row.cacheReadTokens),
    tokens(row.outputTokens),
    `${Math.round(cacheHitRate(row) * 100)}%`,
    `$${row.cost.toFixed(2)}`,
    `$${row.saved.toFixed(2)}`,
  ];
  const table = [COLUMNS, ...rows.map(cells), cells(total)];
  const widths = COLUMNS.map((_, column) => Math.max(...table.map((line) => (line[column] ?? "").length)));
  const lines = table.map((line) =>
    line
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)))
      .join("  "),
  );
  lines.splice(lines.length - 1, 0, "-".repeat(lines[0]?.length ?? 0));
  if (total.unpriced > 0) {
    lines.push("", `${total.unpriced} request(s) used a model with no price in prices.toml and count as $0.`);
  }
  return lines.join("\n");
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

const spentAndCached = (row: ReportRow) => `$${row.cost.toFixed(2)} spent, $${row.saved.toFixed(2)} cached`;

/**
 * One line for an agent's status bar: what its session spent and what the prompt cache took off it, then today.
 * `session` is null for an agent not started by `grenier run`.
 */
export function formatStatusLine(today: ReportRow, session: ReportRow | null): string {
  const first = session ? `session ${spentAndCached(session)}` : "not started with grenier run";
  return `grenier · ${first} · today ${spentAndCached(today)}`;
}

/** Report rows ordered by cost, the most spent first, then by key. */
export function mostSpentFirst(rows: readonly ReportRow[]): ReportRow[] {
  return [...rows].sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
}

/** Today per project, the most spent first, one line each, for the desktop app's menu bar. */
export function formatToday(repos: readonly ReportRow[]): string {
  if (repos.length === 0) return "Nothing spent yet";
  return mostSpentFirst(repos)
    .map((row) => `${row.key}: ${spentAndCached(row)}`)
    .join("\n");
}
