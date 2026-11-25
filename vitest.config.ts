import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vitest/config";

/** SQL, TOML and CSS files are imported as their text, as esbuild's text loader does in the CLI build. */
export function filesAsText(): Plugin {
  return {
    name: "files-as-text",
    async load(id) {
      if (!id.endsWith(".sql") && !id.endsWith(".toml") && !id.endsWith(".css")) return null;
      return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
    },
  };
}

export default defineConfig({
  plugins: [filesAsText()],
  test: {
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/support/home.ts"],
  },
});
