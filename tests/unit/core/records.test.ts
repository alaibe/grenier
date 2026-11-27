import { builtinType, memberMay, recordProblem } from "@grenier/core";
import { describe, expect, it } from "vitest";

describe("a request's run fields", () => {
  const task = {
    top: "team",
    type: "Task",
    title: "Bump hono",
    body: "",
    fields: { status: "doing", routine: "r1" },
    anchors: [],
    links: [{ kind: "record", ref: "r1" }],
  };

  it("are its status, result and machine, which the machine that ran it sets", () => {
    expect(builtinType("Task")?.fields.map((field) => field.name)).toEqual([
      "status",
      "owner",
      "routine",
      "result",
      "machine",
    ]);
    const ran = { ...task, fields: { ...task.fields, status: "done", result: "Bumped.", machine: "bob-mbp" } };
    expect(memberMay(task, ran, "me:bob", true)).toBe(true);
    expect(memberMay(task, { ...task, fields: { ...task.fields, version: 2 } }, "me:bob", true)).toBe(false);
  });

  it("keep its anchors and links as they were", () => {
    const anchors = [{ kind: "item", repoId: null, ref: "linear:acme/LIN-1", version: "1" }];
    expect(memberMay(task, { ...task, anchors }, "me:bob", true)).toBe(false);
    expect(memberMay(task, { ...task, links: [{ kind: "record", ref: "r2" }] }, "me:bob", true)).toBe(false);
    expect(memberMay(task, { ...task, links: [...task.links] }, "me:bob", true)).toBe(true);
  });
});

describe("a routine and its tasks", () => {
  const routine = {
    type: "Routine",
    title: "Triage",
    body: "Triage.",
    fields: { mode: "read-only", state: "running" },
  };
  const task = { type: "Task", title: "Triage, today", body: "", fields: { status: "to-do", routine: "r1" } };

  it("live only in Team", () => {
    expect(recordProblem({ ...routine, top: "team" }, builtinType("Routine"))).toBeNull();
    expect(recordProblem({ ...task, top: "team" }, builtinType("Task"))).toBeNull();
    for (const top of ["me", "me:bob"]) {
      expect(recordProblem({ ...routine, top }, builtinType("Routine"))).toBe("a routine and its tasks live in Team");
      expect(recordProblem({ ...task, top }, builtinType("Task"))).toBe("a routine and its tasks live in Team");
    }
    expect(recordProblem({ ...task, top: "me", fields: { status: "to-do" } }, builtinType("Task"))).toBeNull();
  });
});
