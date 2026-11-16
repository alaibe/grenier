import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vitest/config";

function sqlAsText(): Plugin {
  return {
    name: "sql-as-text",
    async load(id) {
      if (!id.endsWith(".sql")) return null;
      return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
    },
  };
}

export default defineConfig({
  plugins: [sqlAsText()],
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
