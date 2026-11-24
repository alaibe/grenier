import { describe, expect, it } from "vitest";
import { routineTitle, takesRequests } from "../../../apps/desktop/src/requests.ts";

const routines = [
  { id: "r1", title: "Update dependencies", fields: { trigger: "request" } },
  { id: "r2", title: "Librarian", fields: { trigger: "schedule", schedule: "daily 05:00" } },
  { id: "r3", title: "Triage", fields: {} },
];

describe("the Requests part of Routines", () => {
  it("names the routine of every task and run, scheduled ones too", () => {
    expect(routineTitle(routines, "r2")).toBe("Librarian");
    expect(routineTitle(routines, "r1")).toBe("Update dependencies");
    expect(routineTitle(null, "r2")).toBe("a routine");
  });

  it("files requests only for the routines that take them", () => {
    expect(routines.filter(takesRequests).map((routine) => routine.id)).toEqual(["r1", "r3"]);
  });
});
