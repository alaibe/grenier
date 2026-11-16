import { readdirSync, readFileSync } from "node:fs";
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

describe("docs/guide, as the site copies it", () => {
  const dir = new URL("../../../docs/guide/", import.meta.url);
  const pages = readdirSync(dir).filter((name) => name.endsWith(".md"));

  it("links between its pages as ./page.md, and has no bare <word> a Markdown renderer would take for HTML", () => {
    for (const page of pages) {
      const text = readFileSync(new URL(page, dir), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
        if (!target || /^(https?:|#)/.test(target)) continue;
        expect(target, `${page}: ${target}`).toMatch(/^\.\/[\w-]+\.md(#[\w-]+)?$/);
      }
      const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      expect(prose.match(/(?<!\\)<[a-z][\w-]*>/gi) ?? [], page).toEqual([]);
    }
  });
});
