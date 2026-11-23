import type { UsageWithSession } from "@grenier/store";

/** A request whose input is at least this share cache writes counts towards churn. */
export const CHURN_WRITE_SHARE = 0.5;
/** This many such requests in a row flag the session. */
export const CHURN_RUN = 3;

export interface CacheRow {
  sessionId: string;
  requests: number;
  /** input + cache writes + cache reads */
  inputTokens: number;
  writeShare: number;
  readShare: number;
  /** The longest run of consecutive requests whose input was mostly cache writes. */
  longestWriteRun: number;
  /** The prompt cache keeps being rewritten instead of read: something in the prefix changes between requests. */
  churn: boolean;
}

/** Per session, how much of the input was written to the prompt cache and how much read from it. Observe only. */
export function cacheReport(rows: readonly UsageWithSession[]): CacheRow[] {
  const sessions = new Map<string, UsageWithSession[]>();
  for (const row of rows) {
    const requests = sessions.get(row.sessionId);
    if (requests) requests.push(row);
    else sessions.set(row.sessionId, [row]);
  }

  return [...sessions.entries()].map(([sessionId, requests]) => {
    let input = 0;
    let writes = 0;
    let reads = 0;
    let run = 0;
    let longest = 0;
    for (const request of [...requests].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
      const write = request.cacheWriteTokens ?? 0;
      const read = request.cacheReadTokens ?? 0;
      const total = (request.inputTokens ?? 0) + write + read;
      input += total;
      writes += write;
      reads += read;
      run = total > 0 && write / total >= CHURN_WRITE_SHARE ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    return {
      sessionId,
      requests: requests.length,
      inputTokens: input,
      writeShare: input === 0 ? 0 : writes / input,
      readShare: input === 0 ? 0 : reads / input,
      longestWriteRun: longest,
      churn: longest >= CHURN_RUN,
    };
  });
}

export function formatCacheReport(rows: readonly CacheRow[]): string {
  if (rows.length === 0) return "No requests in this period.";
  const header = ["session", "requests", "input", "cache write", "cache read", ""];
  const lines = rows.map((row) => [
    row.sessionId,
    String(row.requests),
    String(row.inputTokens),
    `${Math.round(row.writeShare * 100)}%`,
    `${Math.round(row.readShare * 100)}%`,
    row.churn ? `high churn (${row.longestWriteRun} writes in a row)` : "",
  ]);
  const table = [header, ...lines];
  const widths = header.map((_, column) => Math.max(...table.map((line) => (line[column] ?? "").length)));
  const text = table.map((line) =>
    line
      .map((cell, column) =>
        column === 0 || column === line.length - 1
          ? cell.padEnd(widths[column] ?? 0)
          : cell.padStart(widths[column] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
  if (rows.some((row) => row.churn)) {
    text.push(
      "",
      `High churn: ${CHURN_RUN}+ requests in a row were mostly cache writes. Something early in the prompt (a timestamp, a`,
      "changing tool list, unsorted JSON) changes between requests, so the cache is rewritten instead of read.",
    );
  }
  return text.join("\n");
}
