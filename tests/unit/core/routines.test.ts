import { allowedTools, isAction, nextDue, READ_TOOLS, readsByName, routineHash } from "@grenier/core";
import { describe, expect, it } from "vitest";

const routine = (fields: Record<string, unknown>, body = "Update, then test.") => ({
  title: "Update dependencies",
  body,
  fields,
});

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

describe("approving a routine", () => {
  it("is needed again when its text, a tool or the repo changes, not when its schedule does", async () => {
    const approved = await routineHash(routine({ tools: ["Edit"], repo: "r1", trigger: "request" }));
    expect(await routineHash(routine({ tools: ["Edit"], repo: "r1", trigger: "schedule" }))).toBe(approved);
    expect(await routineHash(routine({ tools: ["Edit", "Bash"], repo: "r1" }))).not.toBe(approved);
    expect(await routineHash(routine({ tools: ["Edit"], repo: "r2" }))).not.toBe(approved);
    expect(await routineHash(routine({ tools: ["Edit"], repo: "r1" }, "Update everything."))).not.toBe(approved);
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
});
