import {
  acts,
  builtinType,
  isAction,
  isRunning,
  mayCall,
  nextDue,
  READ_TOOLS,
  ROUTINE_TEMPLATES,
  readsByName,
  recordProblem,
  runSettings,
} from "@grenier/core";
import { describe, expect, it } from "vitest";

describe("what a routine's run may call", () => {
  it("reads only, until its machine lets it act; then anything, auto mode judging each call", () => {
    for (const mode of ["read-only", "shadow"] as const) {
      for (const tool of [...READ_TOOLS, "mcp__grenier__get", "mcp__linear__list_issues"]) {
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
    for (const tool of ["exec_command", "write_stdin", "update_plan", "local_shell", "mcp__grenier__get"]) {
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
    expect(isAction("Read", "claude")).toBe(false);
    expect(isAction("mcp__grenier__set", "claude")).toBe(false);
    expect(isAction("Edit", "claude")).toBe(true);
    expect(isAction("exec_command", "codex")).toBe(false);
    expect(isAction("apply_patch", "codex")).toBe(true);
    expect(isAction("mcp__linear__update_issue", "codex")).toBe(true);
  });
});

describe("a routine as its admin set it", () => {
  it("runs in its mode, with `limited`'s actions a day, only while running", () => {
    expect(runSettings({ mode: "limited", limit: 3 })).toEqual({ mode: "limited", limit: 3 });
    expect(runSettings({ mode: "on" })).toEqual({ mode: "on", limit: 10 });
    expect(runSettings({ mode: "wild", limit: -1 })).toEqual({ mode: "read-only", limit: 10 });
    expect(isRunning({ fields: { state: "running" } })).toBe(true);
    expect(isRunning({ fields: { state: "paused" } })).toBe(false);
    expect(isRunning({ fields: {} })).toBe(false);
  });

  it("names its mode and whether it is running, or the store refuses it", () => {
    const type = builtinType("Routine");
    const routine = (fields: Record<string, unknown>) => ({ type: "Routine", title: "Tidy", body: "Tidy.", fields });
    expect(recordProblem(routine({ mode: "shadow", state: "paused" }), type)).toBeNull();
    expect(recordProblem(routine({ state: "running" }), type)).toContain("needs mode");
    expect(recordProblem(routine({ mode: "on" }), type)).toContain("needs state");
    expect(recordProblem(routine({ mode: "on", state: "approved" }), type)).toContain("running, paused");
  });

  it("can start from a template that fills in a routine the store takes", () => {
    for (const template of ROUTINE_TEMPLATES) {
      expect(nextDue(template.schedule, Date.now())).not.toBeNull();
      const fields = { schedule: template.schedule, mode: template.mode, state: "running" };
      const record = { type: "Routine", title: template.title, body: template.prompt, fields };
      expect(recordProblem(record, builtinType("Routine"))).toBeNull();
    }
    expect(ROUTINE_TEMPLATES.find((template) => template.id === "keeper")?.prompt).toContain("Team/<repository>");
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
