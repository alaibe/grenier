import {
  budgetMessage,
  canonicalJson,
  copiedLines,
  defaultConfig,
  effectiveLimits,
  firstBreach,
  LoopDetector,
  sha256,
} from "@grenier/core";
import { describe, expect, it } from "vitest";

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("gives equal text for objects written in a different order", () => {
    expect(canonicalJson({ path: "a", limit: 2 })).toBe(canonicalJson({ limit: 2, path: "a" }));
  });
});

describe("sha256", () => {
  it("hashes text to hex", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
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

  it("fires again for a new streak once the old one has left the window", () => {
    const detector = new LoopDetector(2, 3);
    const fired = ["a", "a", "b", "c", "d", "a", "a"].map((hash) => detector.observe(hash));
    expect(fired).toEqual([false, true, false, false, false, false, true]);
  });
});

describe("effectiveLimits", () => {
  const configured = { ...defaultConfig().budgets, daily: 10, session: 3 };

  it("uses the config's limits when none is stored", () => {
    expect(effectiveLimits(configured, [], "app")).toEqual([
      { scope: "daily", key: "", limit: 10 },
      { scope: "session", key: "", limit: 3 },
    ]);
  });

  it("prefers stored limits and adds the repository's own", () => {
    const stored = [
      { scope: "daily", key: "", limitAmount: 20 },
      { scope: "repo", key: "app", limitAmount: 1 },
      { scope: "repo", key: "other", limitAmount: 5 },
    ];
    expect(effectiveLimits(configured, stored, "app")).toEqual([
      { scope: "daily", key: "", limit: 20 },
      { scope: "session", key: "", limit: 3 },
      { scope: "repo", key: "app", limit: 1 },
    ]);
  });

  it("has no limit when neither sets one", () => {
    expect(effectiveLimits(defaultConfig().budgets, [], null)).toEqual([]);
  });
});

describe("firstBreach", () => {
  const limits = [
    { scope: "daily" as const, key: "", limit: 10 },
    { scope: "session" as const, key: "", limit: 3 },
  ];

  it("is the first limit reached, counting an exact match as reached", () => {
    expect(firstBreach(limits, (limit) => (limit.scope === "daily" ? 4 : 3))).toEqual({
      scope: "session",
      key: "",
      limit: 3,
      spent: 3,
    });
  });

  it("is null under every limit", () => {
    expect(firstBreach(limits, () => 1)).toBeNull();
  });

  it("is a limit the next request would pass, with what it is expected to cost", () => {
    expect(firstBreach(limits, () => 2.5, 0.75)).toEqual({
      scope: "session",
      key: "",
      limit: 3,
      spent: 2.5,
      next: 0.75,
    });
    expect(firstBreach(limits, () => 2.5, 0.5)).toBeNull();
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

describe("budgetMessage", () => {
  it("names the limit, the spend and the command to change it", () => {
    expect(budgetMessage({ scope: "repo", key: "app", limit: 2, spent: 2.5 })).toBe(
      "Grenier stopped this request: the daily budget of $2.00 for app is reached ($2.50 spent). To change it, run: grenier budget set --repo app=<amount>",
    );
    expect(budgetMessage({ scope: "daily", key: "", limit: 10, spent: 10 })).toContain(
      "grenier budget set --daily <amount>",
    );
    expect(budgetMessage({ scope: "session", key: "", limit: 3, spent: 3.1 })).toContain(
      "this session's budget of $3.00",
    );
  });
});
