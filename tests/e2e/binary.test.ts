import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { version } from "../../apps/cli/package.json";

// The bundle `pnpm build` writes; `pnpm test:e2e` builds it first.
const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));
const execFileAsync = promisify(execFile);

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
    expect(out).toContain("(schema 11)");
    expect(out).toContain("daemon    stopped");
    expect(existsSync(join(dir, ".grenier", "grenier.db"))).toBe(true);
  });

  it("creates the database from several processes at once, as the app and its daemon do on a first launch", async () => {
    for (let round = 0; round < 20; round++) {
      const env = { PATH: process.env.PATH, GRENIER_HOME: join(dir, `concurrent-${round}`) };
      const runs = await Promise.allSettled(
        Array.from({ length: 4 }, () => execFileAsync(BINARY, ["status"], { env })),
      );
      expect(runs.flatMap((run) => (run.status === "rejected" ? [String(run.reason)] : []))).toEqual([]);
    }
  });
});
