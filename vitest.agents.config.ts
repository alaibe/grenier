import { defineConfig } from "vitest/config";
import { filesAsText } from "./vitest.config.ts";

export default defineConfig({
  plugins: [filesAsText()],
  test: {
    include: ["tests/agents/**/*.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 120_000,
  },
});
