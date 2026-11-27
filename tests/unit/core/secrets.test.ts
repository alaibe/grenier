import { secretIn } from "@grenier/core/records";
import { describe, expect, it } from "vitest";

// Built from parts, so this file holds no key-shaped literal a scanner would flag.
const key = (...parts: string[]) => parts.join("");

describe("what looks like a key", () => {
  it("finds the formats secret scanners know, and leaves ordinary text alone", () => {
    for (const text of [
      key("sk_", "live_", "a".repeat(24)),
      key("AI", "za", "B".repeat(35)),
      key("npm", "_", "c".repeat(36)),
      key("gl", "pat-", "d".repeat(20)),
      key("https://hooks.slack.com/services/", "T0000/B0000/", "e".repeat(24)),
      key("hf", "_", "f".repeat(34)),
      key("SG", ".", "g".repeat(22), ".", "h".repeat(43)),
      key("AK", "IA", "ABCDEFGHIJKLMNOP"),
    ]) {
      expect(secretIn(`Use ${text} here.`)).toBe("it holds what looks like a key or a token");
    }
    expect(secretIn("Deploys go through the sk_ prefix check on Friday.")).toBeNull();
  });
});
