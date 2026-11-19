import { cacheSavingsOf, costOf, loadPrices, priceOf } from "@grenier/log";
import { describe, expect, it } from "vitest";

const prices = loadPrices();
const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("loadPrices", () => {
  it("prices the current models", () => {
    expect(prices["claude-opus-5-5"]).toMatchObject({ input: 4, output: 20, cache_read: 0.2 });
    expect(prices["claude-sonnet-5-5"]).toMatchObject({ input: 2, output: 10, cache_read: 0.1 });
    expect(prices["claude-haiku-5-5"]?.long_context?.threshold).toBe(100_000);
  });

  it("lays the config's prices over the shipped ones", () => {
    const custom = { input: 1, output: 1, cache_write_5m: 1, cache_write_1h: 1, cache_read: 1 };
    const merged = loadPrices({ "claude-opus-5-5": custom, mine: custom });
    expect(merged["claude-opus-5-5"]?.input).toBe(1);
    expect(merged.mine).toBe(custom);
    expect(merged["claude-sonnet-5-5"]?.input).toBe(2);
  });
});

describe("priceOf", () => {
  it("finds a dated id by its undated name, and nothing for an unknown model", () => {
    expect(priceOf("claude-opus-5-5-20260101", prices)).toBe(prices["claude-opus-5-5"]);
    expect(priceOf("claude-opus-5-5[1m]", prices)).toBe(prices["claude-opus-5-5"]);
    expect(priceOf("gpt-x", prices)).toBeNull();
  });
});

describe("costOf", () => {
  it("prices each kind of token at its own rate", () => {
    const cost = costOf(
      "claude-opus-5-5",
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      prices,
    );
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5, 10);
  });

  it("prices 1-hour cache writes apart from 5-minute ones", () => {
    const cost = costOf(
      "claude-opus-5-5",
      { ...none, cacheWriteTokens: 2_000_000, cacheWrite1hTokens: 1_000_000 },
      prices,
    );
    expect(cost).toBeCloseTo(5 + 8, 10);
  });

  it("applies the fast-mode multiplier", () => {
    expect(costOf("claude-opus-5-5", { ...none, outputTokens: 1_000_000, speed: "fast" }, prices)).toBeCloseTo(40, 10);
  });

  it("switches to long-context prices past the threshold", () => {
    expect(costOf("claude-haiku-5-5", { ...none, inputTokens: 100_000 }, prices)).toBeCloseTo(0.01, 10);
    expect(costOf("claude-haiku-5-5", { ...none, inputTokens: 100_001 }, prices)).toBeCloseTo(0.0500005, 10);
  });

  it("is null for a model with no price or no model", () => {
    expect(costOf("unknown", { ...none, inputTokens: 10 }, prices)).toBeNull();
    expect(costOf(null, none, prices)).toBeNull();
  });
});

describe("cacheSavingsOf", () => {
  it("is what the cache reads would have cost as input, minus what they cost", () => {
    expect(cacheSavingsOf("claude-opus-5-5", 1_000_000, prices)).toBeCloseTo(3.8, 10);
    expect(cacheSavingsOf("unknown", 1_000_000, prices)).toBe(0);
  });
});
