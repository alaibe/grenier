import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vitest/config";

function filesAsText(): Plugin {
  return {
    name: "files-as-text",
    async load(id) {
      if (!id.endsWith(".sql") && !id.endsWith(".toml")) return null;
      return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
    },
  };
}

export default defineConfig({
  plugins: [filesAsText()],
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
