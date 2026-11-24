import { builtinType, memberMay } from "@grenier/core";
import { describe, expect, it } from "vitest";

describe("a request's run fields", () => {
  const task = {
    top: "team",
    type: "Task",
    title: "Bump hono",
    body: "",
    fields: { status: "doing", routine: "r1" },
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
});
