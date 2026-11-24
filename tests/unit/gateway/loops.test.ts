import { LoopDetector } from "@grenier/gateway";
import { describe, expect, it } from "vitest";

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
