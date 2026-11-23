import { defaultConfig } from "@grenier/core";
import { describe, expect, it } from "vitest";
import { availability, type Probes, withinHours } from "../../../apps/cli/src/machine.ts";

function probes(
  change: Partial<{ plugged: boolean | null; idle: number | null; load: number; memory: number; hour: number }> = {},
): Probes {
  const now = { plugged: true, idle: 3600, load: 0.1, memory: 0.4, hour: 14, ...change };
  return {
    pluggedIn: async () => now.plugged,
    idleSeconds: async () => now.idle,
    load: () => now.load,
    memory: async () => now.memory,
    hour: () => now.hour,
  };
}

const rules = { ...defaultConfig().machine, routines: true };

describe("whether the machine is available", () => {
  it("is available when every rule holds, with room from what is free", async () => {
    const state = await availability(rules, probes(), false);
    expect(state.state).toBe("available");
    expect(state.room).toBeCloseTo(0.9 * 0.6);
  });

  it("is away while its person uses it, on battery, or busy with other work, and says why", async () => {
    expect((await availability(rules, probes({ idle: 120 }), false)).reasons).toEqual(["in use: idle 2 of 10 minutes"]);
    expect((await availability(rules, probes({ plugged: false }), false)).reasons).toEqual(["on battery"]);
    expect((await availability(rules, probes({ load: 0.8, memory: 0.9 }), false)).reasons).toEqual([
      "CPU at 80%, above 50%",
      "memory at 90%, above 85%",
    ]);
    expect((await availability(rules, probes({ idle: null }), false)).state).toBe("away");
    expect((await availability({ ...rules, idle_minutes: 0 }, probes({ idle: null }), false)).state).toBe("available");
  });

  it("is busy while a run is going", async () => {
    expect((await availability(rules, probes(), true)).state).toBe("busy");
  });

  it("keeps to its hours, overnight included", () => {
    expect(withinHours("0-24", 3)).toBe(true);
    expect(withinHours("22-7", 23)).toBe(true);
    expect(withinHours("22-7", 6)).toBe(true);
    expect(withinHours("22-7", 12)).toBe(false);
    expect(withinHours("9-18", 18)).toBe(false);
  });
});
