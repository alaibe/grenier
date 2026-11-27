import { buildReport, formatToday, loadPrices, projectOf } from "@grenier/log";
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
    cwd: "/work/app",
    client: "claude",
    startedAt: 0,
    ...overrides,
  };
}

describe("buildReport", () => {
  const rows = [
    row({}),
    row({ sessionId: "s2", repoRoot: "/work/api/", ts: new Date(2026, 10, 17, 9).getTime(), cost: 0.02 }),
    row({ sessionId: "untagged", repoRoot: null, cwd: null, model: "unknown", cost: null }),
  ];

  it("groups by day in local time", () => {
    expect(buildReport(rows, "day", prices).map((r) => [r.key, r.requests])).toEqual([
      ["2026-11-16", 2],
      ["2026-11-17", 1],
    ]);
  });

  it("groups by session and by project", () => {
    expect(buildReport(rows, "session", prices).map((r) => r.key)).toEqual(["s1", "s2", "untagged"]);
    expect(buildReport(rows, "repo", prices).map((r) => r.key)).toEqual([
      "app",
      "api",
      "(not started with grenier run)",
    ]);
  });

  it("groups by folder name alone, whatever the repository", () => {
    const projects = buildReport(
      [
        row({ repoRoot: "/work/app", repoId: "r1" }),
        row({ repoRoot: "/home/old/app", repoId: "r2", cwd: "/home/old/app/src" }),
        row({ repoRoot: "/work/app-fix", repoId: "r1" }),
        row({ repoRoot: null, repoId: null, cwd: "/tmp/scratch" }),
      ],
      "repo",
      prices,
    );
    expect(projects.map((r) => [r.key, r.requests])).toEqual([
      ["app", 2],
      ["app-fix", 1],
      ["scratch", 1],
    ]);
  });

  it("adds up tokens, cost and savings, and counts unpriced requests", () => {
    const [day] = buildReport(rows, "day", prices);
    expect(day).toMatchObject({ inputTokens: 200, cacheReadTokens: 1800, outputTokens: 100, unpriced: 1 });
    expect(day?.cost).toBeCloseTo(0.01, 10);
    expect(day?.saved).toBeCloseTo((900 * 3.8) / 1_000_000, 12);
  });
});

describe("formatToday", () => {
  it("shows today per project for the menu bar, the most spent first", () => {
    const repos = buildReport(
      [
        row({ cost: 0.5, cacheReadTokens: 0 }),
        row({ repoRoot: null, cwd: null, cost: 0.25, cacheReadTokens: 0 }),
        row({ repoRoot: "/work/api", cost: 0.75, cacheReadTokens: 1_000_000 }),
        row({ repoRoot: "/work/app", cost: 0.5, cacheReadTokens: 0 }),
      ],
      "repo",
      prices,
    );
    expect(formatToday(repos).split("\n")).toEqual([
      "app: $1.00 spent, $0.00 cached",
      "api: $0.75 spent, $3.80 cached",
      "(not started with grenier run): $0.25 spent, $0.00 cached",
    ]);
    expect(formatToday([])).toBe("Nothing spent yet");
  });
});

describe("projectOf", () => {
  it("takes the repository's folder, else the one the session started in", () => {
    expect(projectOf({ repoRoot: "/work/app", cwd: "/work/app/packages/ui" })).toBe("app");
    expect(projectOf({ repoRoot: null, cwd: "/tmp/scratch" })).toBe("scratch");
    expect(projectOf({ repoRoot: null, cwd: null })).toBeNull();
  });
});
