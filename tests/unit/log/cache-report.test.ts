import { cacheReport, formatCacheReport } from "@grenier/log";
import type { UsageWithSession } from "@grenier/store";
import { describe, expect, it } from "vitest";

let id = 0;
function request(
  sessionId: string,
  inputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
): UsageWithSession {
  id += 1;
  return {
    id,
    sessionId,
    ts: id,
    model: "claude-opus-5-5",
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: 10,
    cost: 0,
    status: 200,
    repoRoot: null,
    repoId: null,
  };
}

describe("cacheReport", () => {
  it("gives each session's write and read shares of input", () => {
    const [row] = cacheReport([request("s1", 100, 900, 0), request("s1", 100, 0, 900)]);
    expect(row).toMatchObject({ sessionId: "s1", requests: 2, inputTokens: 2000, writeShare: 0.45, readShare: 0.45 });
    expect(row?.churn).toBe(false);
  });

  it("flags a session whose cache is rewritten three requests in a row, not one that warms up once", () => {
    const warm = [request("warm", 10, 5000, 0), request("warm", 10, 100, 5000), request("warm", 10, 100, 5100)];
    const churning = [request("churn", 10, 5000, 0), request("churn", 10, 5100, 0), request("churn", 10, 5200, 0)];
    const rows = cacheReport([...warm, ...churning]);
    expect(rows.map((row) => [row.sessionId, row.churn, row.longestWriteRun])).toEqual([
      ["warm", false, 1],
      ["churn", true, 3],
    ]);
  });

  it("is empty with no requests", () => {
    expect(cacheReport([])).toEqual([]);
  });
});

describe("formatCacheReport", () => {
  it("shows the shares, marks churn and explains it", () => {
    const text = formatCacheReport(
      cacheReport([request("s9", 10, 5000, 0), request("s9", 10, 5000, 0), request("s9", 10, 5000, 0)]),
    );
    expect(text.split("\n")[1]).toMatch(/^s9\s+3\s+15030\s+100%\s+0%\s+high churn \(3 writes in a row\)$/);
    expect(text).toContain("so the cache is rewritten instead of read");
    expect(formatCacheReport([])).toBe("No requests in this period.");
  });
});
