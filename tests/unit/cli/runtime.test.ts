import { defaultConfig } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import type { Embedder } from "@grenier/index";
import { describe, expect, it } from "vitest";
import { EMBEDDER_RETRY_MS, embedderLoader } from "../../../apps/cli/src/runtime.ts";

const embedder = { model: "m", dimensions: 1, embed: async () => [] } as unknown as Embedder;
const paths = resolvePaths({ GRENIER_HOME: "/nowhere" });

describe("embedderLoader", () => {
  it("loads once, and after a failure tries again a minute later instead of never", async () => {
    let calls = 0;
    let clock = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return embedder;
    };
    const lines: string[] = [];
    const get = embedderLoader(defaultConfig(), paths, (line) => lines.push(line), { load, now: () => clock });

    expect(await get()).toBeNull();
    expect(await get()).toBeNull();
    expect(calls).toBe(1);
    clock += EMBEDDER_RETRY_MS;
    expect(await get()).toBe(embedder);
    expect(await get()).toBe(embedder);
    expect(calls).toBe(2);
    expect(lines).toEqual(["grenier: embeddings unavailable, using full-text search only: network down"]);
  });
});
