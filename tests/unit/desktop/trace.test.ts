import { describe, expect, it } from "vitest";
import { rereadsOf, type TraceStep, treeOf } from "../../../apps/desktop/src/trace.ts";

let id = 0;
const step = (kind: TraceStep["kind"], path: string | null, more: Partial<TraceStep> = {}): TraceStep => ({
  id: ++id,
  callId: `c${id}`,
  part: 0,
  ts: id,
  tool: "Read",
  kind,
  path,
  startLine: null,
  endLine: null,
  label: null,
  outcome: null,
  ...more,
});

describe("the tree of a trace", () => {
  it("lists the repository, then directories before files, sharing the row of a lone directory", () => {
    const steps = [
      step("read", "packages/gateway/src/proxy.ts"),
      step("search", "packages/gateway"),
      step("read", "README.md"),
      step("edit", "packages/gateway/src/trace.ts"),
      step("search", null),
      step("read", "apps/cli/src/daemon.ts"),
    ];
    const tree = treeOf("grenier", steps);
    expect(tree.rows.map((row) => `${"  ".repeat(row.depth)}${row.label}${row.file ? "" : "/"}`)).toEqual([
      "grenier/",
      "  apps/cli/src/",
      "    daemon.ts",
      "  packages/gateway/",
      "    src/",
      "      proxy.ts",
      "      trace.ts",
      "  README.md",
    ]);
    expect(tree.rowOfStep).toEqual([5, 3, 7, 6, 0, 2]);
    expect([...tree.files].sort()).toEqual([
      "README.md",
      "apps/cli/src/daemon.ts",
      "packages/gateway/src/proxy.ts",
      "packages/gateway/src/trace.ts",
    ]);
  });
});

describe("reads of lines already read", () => {
  it("counts a read overlapping an earlier one, unless the file changed in between or a read failed", () => {
    const steps = [
      step("read", "a.ts", { startLine: 1, endLine: 50 }),
      step("read", "a.ts", { startLine: 40, endLine: 80 }),
      step("read", "a.ts", { startLine: 100, endLine: 120 }),
      step("edit", "a.ts"),
      step("read", "a.ts", { startLine: 1, endLine: 10 }),
      step("read", "b.ts", { outcome: "error" }),
      step("read", "b.ts"),
      step("read", "b.ts", { startLine: 5, endLine: 6 }),
    ];
    expect([...rereadsOf(steps)]).toEqual([1, 7]);
  });
});
