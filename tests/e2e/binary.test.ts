import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { version } from "../../apps/cli/package.json";

// The bundle `pnpm build` writes; `pnpm test:e2e` builds it first.
const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "grenier-e2e-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function grenier(...args: string[]): string {
  return execFileSync(BINARY, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GRENIER_HOME: join(dir, ".grenier") },
  });
}

describe("the built binary", () => {
  it("prints its version", () => {
    expect(grenier("--version").trim()).toBe(version);
  });

  it("runs status on a fresh machine, creating the database", () => {
    const out = grenier("status");
    expect(out).toContain("(schema 5)");
    expect(out).toContain("daemon    stopped");
    expect(existsSync(join(dir, ".grenier", "grenier.db"))).toBe(true);
  });
});
