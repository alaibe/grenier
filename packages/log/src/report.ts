import { folderName } from "@grenier/core";
import type { ReportRow } from "@grenier/core/api";
import type { UsageWithSession } from "@grenier/store";
import { cacheSavingsOf, type Prices } from "./cost.ts";

export type GroupBy = "day" | "session" | "repo";

export type { ReportRow };

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

/** What spending is grouped under everywhere: the repository's folder name, else the starting folder's. */
export function projectOf(session: { repoRoot: string | null; cwd: string | null }): string | null {
  const folder = session.repoRoot ?? session.cwd;
  return folder ? folderName(folder) : null;
}

function localDate(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight. */
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

/** Dollars with cents, or with the two digits that matter below ten cents, as the app writes them. */
export const money = (amount: number) =>
  amount === 0 || Math.abs(amount) >= 0.1 ? `$${amount.toFixed(2)}` : `$${Number(amount.toPrecision(2))}`;

const spentAndCached = (row: ReportRow) => `${money(row.cost)} spent, ${money(row.saved)} cached`;

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
