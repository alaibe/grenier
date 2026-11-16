import { readdirSync, readFileSync } from "node:fs";
import { migrations } from "@grenier/store";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../../packages/store/migrations/", import.meta.url);

interface Journal {
  entries: { idx: number; tag: string }[];
}

describe("migrations", () => {
  it("list drizzle-kit's journal, in order, numbered from 1", () => {
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", DIR), "utf8")) as Journal;
    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual(
      journal.entries.map((entry) => ({ version: entry.idx + 1, name: entry.tag })),
    );
  });

  it("carry each SQL file's text", () => {
    const files = readdirSync(DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations.map((migration) => `${migration.name}.sql`)).toEqual(files);
    for (const migration of migrations) {
      expect(migration.sql).toBe(readFileSync(new URL(`${migration.name}.sql`, DIR), "utf8"));
    }
  });
});
