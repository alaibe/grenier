import {
  allowedTools,
  isAction,
  judgeByCode,
  nextDue,
  pickVersion,
  READ_TOOLS,
  readsByName,
  routineHash,
} from "@grenier/core";
import { describe, expect, it } from "vitest";

const routine = (fields: Record<string, unknown>) => ({ title: "Update dependencies", fields });
const versions = [
  { version: 1, prompt: "Update.", status: "retired" },
  { version: 2, prompt: "Update, then test.", status: "production" },
  { version: 3, prompt: "Update, test, explain.", status: "testing" },
];

describe("what a routine's run may call", () => {
  it("reads only, until its machine lets it act", () => {
    const tools = ["Edit", "Bash(pnpm test:*)", "mcp__linear__create_issue", "mcp__linear__list_issues"];
    const readOnly = allowedTools("read-only", tools);
    expect(readOnly).toEqual(
      expect.arrayContaining([...READ_TOOLS, "mcp__grenier__recall", "mcp__linear__list_issues"]),
    );
    expect(readOnly).not.toContain("Edit");
    expect(readOnly).not.toContain("mcp__linear__create_issue");
    expect(allowedTools("shadow", tools)).toEqual(readOnly);
    expect(allowedTools("limited", tools)).toEqual(expect.arrayContaining(["Edit", "mcp__linear__create_issue"]));
    expect(allowedTools("on", tools)).toEqual(allowedTools("limited", tools));
  });

  it("tells reading tools from actions by their names", () => {
    expect(readsByName("mcp__calendar__list_events")).toBe(true);
    expect(readsByName("mcp__github__get_pull_request")).toBe(true);
    expect(readsByName("mcp__github__merge_pull_request")).toBe(false);
    expect(readsByName("Read")).toBe(false);
    expect(isAction("Read")).toBe(false);
    expect(isAction("mcp__grenier__remember")).toBe(false);
    expect(isAction("Edit")).toBe(true);
  });
});

describe("a routine's versions", () => {
  it("runs the latest version in production, or the one asked for unless retired", () => {
    expect(pickVersion(routine({ versions }))?.version).toBe(2);
    expect(pickVersion(routine({ versions }), 3)?.version).toBe(3);
    expect(pickVersion(routine({ versions }), 1)).toBeNull();
    expect(pickVersion(routine({ versions: [] }))).toBeNull();
  });

  it("needs approving again when a prompt, a tool or the repo changes, not when its status does", async () => {
    const approved = await routineHash(routine({ versions, tools: ["Edit"], repo: "r1" }));
    const promoted = versions.map((entry) => ({ ...entry, status: "production" }));
    expect(await routineHash(routine({ versions: promoted, tools: ["Edit"], repo: "r1" }))).toBe(approved);
    expect(await routineHash(routine({ versions, tools: ["Edit", "Bash"], repo: "r1" }))).not.toBe(approved);
    expect(await routineHash(routine({ versions, tools: ["Edit"], repo: "r2" }))).not.toBe(approved);
    const edited = versions.map((entry) => (entry.version === 2 ? { ...entry, prompt: "Update everything." } : entry));
    expect(await routineHash(routine({ versions: edited, tools: ["Edit"], repo: "r1" }))).not.toBe(approved);
  });

  it("scores a result by code when it holds what the case expects", () => {
    expect(judgeByCode("Bumped hono to 4.12.", "hono to 4.12")).toBe(1);
    expect(judgeByCode("Nothing to do.", "hono")).toBe(0);
  });
});

describe("schedules", () => {
  const at = (text: string) => Date.parse(`${text}Z`);

  it("finds the next time, in UTC", () => {
    const monday = at("2026-11-23T10:15:00");
    expect(nextDue("hourly", monday)).toBe(at("2026-11-23T11:00:00"));
    expect(nextDue("daily 09:00", monday)).toBe(at("2026-11-24T09:00:00"));
    expect(nextDue("daily 11:30", monday)).toBe(at("2026-11-23T11:30:00"));
    expect(nextDue("fri 17:00", monday)).toBe(at("2026-11-27T17:00:00"));
    expect(nextDue("weekdays 08:00", at("2026-11-27T09:00:00"))).toBe(at("2026-11-30T08:00:00"));
  });

  it("reads nothing it does not know", () => {
    expect(nextDue("every so often", 0)).toBeNull();
    expect(nextDue("daily 25:00", 0)).toBeNull();
  });
});
