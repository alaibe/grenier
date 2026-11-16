import { readdirSync } from "node:fs";
import { migrations } from "@grenier/store";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../../packages/store/migrations/", import.meta.url);

describe("migrations", () => {
  it("are numbered 1, 2, 3… in order", () => {
    expect(migrations.map((migration) => migration.version)).toEqual(migrations.map((_, index) => index + 1));
  });

  it("list every SQL file in packages/store/migrations, by name and number", () => {
    const files = readdirSync(DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations.map((migration) => `${migration.name}.sql`)).toEqual(files);
    for (const migration of migrations) {
      expect(migration.name.startsWith(String(migration.version).padStart(4, "0"))).toBe(true);
      expect(migration.sql.trim()).not.toBe("");
    }
  });
});
