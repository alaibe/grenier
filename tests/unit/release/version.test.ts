import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bump, check, FILES } from "../../../scripts/version.ts";

const repo = join(import.meta.dirname, "..", "..", "..");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grenier-version-"));
  for (const file of FILES) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    cpSync(join(repo, file.path), join(root, file.path));
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("version", () => {
  it("bumps the patch in every file, and nothing else", () => {
    const before = check(root);
    const [major, minor, patch] = before.split(".").map(Number);
    const next = `${major}.${minor}.${(patch ?? 0) + 1}`;
    const texts = FILES.map((file) => readFileSync(join(root, file.path), "utf8"));

    expect(bump(root)).toBe(next);
    expect(check(root)).toBe(next);
    FILES.forEach((file, index) => {
      const after = readFileSync(join(root, file.path), "utf8").split("\n");
      const original = (texts[index] ?? "").split("\n");
      expect(after.length, file.path).toBe(original.length);
      const changed = after.filter((line, at) => line !== original[at]);
      expect(changed, file.path).toHaveLength(1);
      expect(changed[0], file.path).toContain(`"${next}"`);
    });
  });

  it("leaves other packages in Cargo.lock alone", () => {
    const lock = join(root, "apps/desktop/src-tauri/Cargo.lock");
    const text = readFileSync(lock, "utf8");
    writeFileSync(lock, `${text}\n[[package]]\nname = "other"\nversion = "${check(root)}"\n`);
    bump(root);
    expect(readFileSync(lock, "utf8")).toContain(`name = "other"\nversion = "${check(repo)}"`);
  });

  it("refuses files that disagree", () => {
    const server = join(root, "apps/server/package.json");
    writeFileSync(server, readFileSync(server, "utf8").replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    expect(() => check(root)).toThrow("apps/server/package.json is 9.9.9");
    expect(() => bump(root)).toThrow("9.9.9");
  });
});
