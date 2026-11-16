import { readFileSync } from "node:fs";
import { defaultConfig } from "@grenier/core";
import { describe, expect, it } from "vitest";

const DOC = readFileSync(new URL("../../../docs/guide/configuration.md", import.meta.url), "utf8");

describe("docs/guide/configuration.md", () => {
  it("documents every table and key of the config", () => {
    const config = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
    for (const [table, values] of Object.entries(config)) {
      expect(DOC, `[${table}]`).toContain(table === "prices" ? "[prices." : `[${table}]`);
      for (const key of Object.keys(values)) expect(DOC, `${table}.${key}`).toMatch(new RegExp(`^${key} = `, "m"));
    }
  });
});
