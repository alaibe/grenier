import { acts, isAction, mayCall, nextDue, READ_TOOLS, readsByName, routineHash } from "@grenier/core";
import { describe, expect, it } from "vitest";

const routine = (fields: Record<string, unknown>, body = "Update, then test.") => ({
  title: "Update dependencies",
  body,
  fields,
});

describe("what a routine's run may call", () => {
  it("reads only, until its machine lets it act; then anything, auto mode judging each call", () => {
    for (const mode of ["read-only", "shadow"] as const) {
      for (const tool of [...READ_TOOLS, "mcp__grenier__recall", "mcp__linear__list_issues"]) {
        expect(mayCall("claude", mode, tool)).toBe(true);
      }
      expect(mayCall("claude", mode, "Edit")).toBe(false);
      expect(mayCall("claude", mode, "mcp__linear__create_issue")).toBe(false);
      expect(mayCall("claude", mode, "exec_command")).toBe(false);
    }
    for (const mode of ["limited", "on"] as const) {
      expect(acts(mode)).toBe(true);
      expect(mayCall("claude", mode, "Edit")).toBe(true);
      expect(mayCall("claude", mode, "mcp__linear__create_issue")).toBe(true);
    }
    expect(acts("shadow")).toBe(false);
  });

  it("leaves Codex its own tools, inside its sandbox, and holds its patch tool and MCP tools to the mode", () => {
    for (const tool of ["exec_command", "write_stdin", "update_plan", "local_shell", "mcp__grenier__recall"]) {
      expect(mayCall("codex", "read-only", tool)).toBe(true);
    }
    expect(mayCall("codex", "read-only", "apply_patch")).toBe(false);
    expect(mayCall("codex", "read-only", "mcp__linear__update_issue")).toBe(false);
    expect(mayCall("codex", "on", "apply_patch")).toBe(true);
    expect(mayCall("codex", "on", "mcp__linear__update_issue")).toBe(true);
  });

  it("tells reading tools from actions by their names", () => {
    expect(readsByName("mcp__calendar__list_events")).toBe(true);
    expect(readsByName("mcp__github__get_pull_request")).toBe(true);
    expect(readsByName("mcp__github__merge_pull_request")).toBe(false);
    expect(readsByName("Read")).toBe(false);
    expect(isAction("Read")).toBe(false);
    expect(isAction("mcp__grenier__remember")).toBe(false);
    expect(isAction("Edit")).toBe(true);
    expect(isAction("exec_command", "codex")).toBe(false);
    expect(isAction("apply_patch", "codex")).toBe(true);
    expect(isAction("mcp__linear__update_issue", "codex")).toBe(true);
  });
});

describe("approving a routine", () => {
  it("is needed again when its text or its agent changes, not when its schedule does", async () => {
    const approved = await routineHash(routine({ schedule: "daily 05:00" }));
    expect(await routineHash(routine({ schedule: "hourly" }))).toBe(approved);
    expect(await routineHash(routine({ agent: "codex" }))).not.toBe(approved);
    expect(await routineHash(routine({}, "Update everything."))).not.toBe(approved);
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
