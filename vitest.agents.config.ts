import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/agents/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
