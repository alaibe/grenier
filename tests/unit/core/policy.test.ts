import { canonicalJson, copiedLines, LoopDetector } from "@grenier/core";
import { describe, expect, it } from "vitest";

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("LoopDetector", () => {
  it("fires once when a hash reaches the threshold within the window", () => {
    const detector = new LoopDetector(3, 10);
    expect(["a", "b", "a", "c", "a", "a"].map((hash) => detector.observe(hash))).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it("ignores repeats that fall outside the window", () => {
    const detector = new LoopDetector(3, 4);
    expect(["a", "b", "c", "a", "d", "a"].map((hash) => detector.observe(hash))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("fires again after as many repeats again, so a loop that goes on is caught again", () => {
    const detector = new LoopDetector(3, 10);
    expect(["a", "a", "a", "a", "a", "a"].map((hash) => detector.observe(hash))).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });
});

describe("copiedLines", () => {
  it("is the longest run of lines copied in order, ignoring indentation and blank lines", () => {
    const source = "a();\nb();\n\nc();\nd();\ne();\n";
    expect(copiedLines("See:\n  b();\n  c();\n\n  d();\nThen more.", source)).toBe(3);
    expect(copiedLines("d();\nc();", source)).toBe(1);
    expect(copiedLines("Nothing in common.", source)).toBe(0);
  });
});
