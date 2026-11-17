import {
  buildReport,
  cacheHitRate,
  formatReport,
  formatStatusLine,
  formatToday,
  loadPrices,
  parseSince,
  repoName,
  startOfToday,
  totalOf,
} from "@grenier/log";
import type { UsageWithSession } from "@grenier/store";
import { describe, expect, it } from "vitest";

const prices = loadPrices();

function row(overrides: Partial<UsageWithSession>): UsageWithSession {
  return {
    id: 1,
    sessionId: "s1",
    ts: new Date(2026, 10, 16, 10).getTime(),
    model: "claude-opus-5-5",
    inputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 900,
    outputTokens: 50,
    cost: 0.01,
    status: 200,
    repoRoot: "/work/app",
    repoId: "r1",
    ...overrides,
  };
}

describe("buildReport", () => {
  const rows = [
    row({}),
    row({ sessionId: "s2", repoRoot: "/work/api/", ts: new Date(2026, 10, 17, 9).getTime(), cost: 0.02 }),
    row({ sessionId: "untagged", repoRoot: null, model: "unknown", cost: null }),
  ];

  it("groups by day in local time", () => {
    expect(buildReport(rows, "day", prices).map((r) => [r.key, r.requests])).toEqual([
      ["2026-11-16", 2],
      ["2026-11-17", 1],
    ]);
  });

  it("groups by session and by repository", () => {
    expect(buildReport(rows, "session", prices).map((r) => r.key)).toEqual(["s1", "s2", "untagged"]);
    expect(buildReport(rows, "repo", prices).map((r) => r.key)).toEqual(["app", "api", "(no repository)"]);
  });

  it("adds up tokens, cost and savings, and counts unpriced requests", () => {
    const [day] = buildReport(rows, "day", prices);
    expect(day).toMatchObject({ inputTokens: 200, cacheReadTokens: 1800, outputTokens: 100, unpriced: 1 });
    expect(day?.cost).toBeCloseTo(0.01, 10);
    expect(day?.saved).toBeCloseTo((900 * 3.8) / 1_000_000, 12);
  });
});

describe("cacheHitRate", () => {
  it("is the share of input tokens read from the cache", () => {
    expect(cacheHitRate({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900 })).toBe(0.9);
    expect(cacheHitRate({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBe(0);
  });
});

describe("formatReport", () => {
  it("lays out a table with a total, and notes unpriced requests", () => {
    const text = formatReport(buildReport([row({}), row({ model: "x", cost: null })], "session", prices));
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/requests\s+input\s+cache write\s+cache read\s+output\s+cache hit\s+cost\s+saved$/);
    expect(lines[1]).toMatch(/^s1\s+2\s+200\s+0\s+1800\s+100\s+90%\s+\$0\.01\s+\$0\.00$/);
    expect(lines[3]).toMatch(/^total\s+2/);
    expect(text).toContain("1 request(s) used a model with no price");
  });

  it("says so when there is nothing to show", () => {
    expect(formatReport([])).toBe("No requests in this period.");
  });
});

describe("totalOf, formatStatusLine and formatToday", () => {
  const today = totalOf(buildReport([row({ cost: 1.5 }), row({ sessionId: "s2", cost: 2 })], "session", prices));

  it("adds up rows, and is all zeros for none", () => {
    expect(today).toMatchObject({ key: "total", requests: 2, cost: 3.5, cacheReadTokens: 1800 });
    expect(today.saved).toBeGreaterThan(0);
    expect(totalOf([])).toMatchObject({ requests: 0, cost: 0, saved: 0 });
  });

  it("shows the session, then today", () => {
    const session = totalOf(buildReport([row({ cost: 1.5 })], "session", prices));
    expect(formatStatusLine(today, session)).toMatch(
      /^grenier · session \$1\.50 spent, \$\d+\.\d\d saved · today \$3\.50 spent, \$\d+\.\d\d saved$/,
    );
  });

  it("says when the agent was not started with grenier run", () => {
    expect(formatStatusLine(totalOf([]), null)).toBe(
      "grenier · not started with grenier run · today $0.00 spent, $0.00 saved",
    );
  });

  it("shows today alone for the menu bar", () => {
    expect(formatToday(totalOf([]))).toBe("$0.00 spent · $0.00 saved");
  });
});

describe("parseSince", () => {
  const now = new Date(2026, 10, 16, 12).getTime();

  it("reads durations and dates", () => {
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("12h", now)).toBe(now - 12 * 3_600_000);
    expect(parseSince("30m", now)).toBe(now - 30 * 60_000);
    expect(parseSince("2026-11-01", now)).toBe(new Date(2026, 10, 1).getTime());
  });

  it("refuses anything else", () => {
    expect(() => parseSince("a week", now)).toThrow("--since takes a duration");
  });
});

describe("startOfToday and repoName", () => {
  it("finds local midnight and a repository's name", () => {
    expect(startOfToday(new Date(2026, 10, 16, 15, 30).getTime())).toBe(new Date(2026, 10, 16).getTime());
    expect(repoName("/work/app")).toBe("app");
    expect(repoName("/work/app/")).toBe("app");
  });
});
