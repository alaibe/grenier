import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instructionFiles, readInstructions, writeInstructions } from "../../../apps/cli/src/instructions.ts";

let home: string;
let work: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "grenier-instructions-"));
  work = join(home, "Work");
  mkdirSync(join(work, "checkout", ".git"), { recursive: true });
  writeFileSync(join(work, "checkout", "AGENTS.md"), "# Checkout\n");
  mkdirSync(join(work, "notes"));
  writeFileSync(join(work, "notes", "CLAUDE.md"), "@AGENTS.md\n");
  mkdirSync(join(work, "photos"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "Be brief.\n");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the instructions files", () => {
  it("lists every project's in the work folder and every project's own, made yet or not", () => {
    const files = instructionFiles("~/Work", home);
    expect(files.map((file) => [file.id, file.exists])).toEqual([
      ["global/CLAUDE.md", true],
      ["global/AGENTS.md", false],
      ["project/checkout/CLAUDE.md", false],
      ["project/checkout/AGENTS.md", true],
      ["project/checkout/CLAUDE.local.md", false],
      ["project/notes/CLAUDE.md", true],
      ["project/notes/AGENTS.md", false],
      ["project/notes/CLAUDE.local.md", false],
    ]);
    expect(instructionFiles("", home).map((file) => file.id)).toEqual(["global/CLAUDE.md", "global/AGENTS.md"]);
  });

  it("writes one, makes a new one, and never over a change made since it was read", async () => {
    const read = await readInstructions(work, home, "project/checkout/AGENTS.md");
    expect(read.text).toBe("# Checkout\n");
    const saved = await writeInstructions(
      work,
      home,
      "project/checkout/AGENTS.md",
      "# Checkout\n\nRun pnpm test.\n",
      read.hash,
    );
    expect(readFileSync(join(work, "checkout", "AGENTS.md"), "utf8")).toBe("# Checkout\n\nRun pnpm test.\n");

    writeFileSync(join(work, "checkout", "AGENTS.md"), "An agent's change.\n");
    await expect(writeInstructions(work, home, "project/checkout/AGENTS.md", "Mine.\n", saved.hash)).rejects.toThrow(
      "changed on disk",
    );
    expect(readFileSync(join(work, "checkout", "AGENTS.md"), "utf8")).toBe("An agent's change.\n");

    expect(await readInstructions(work, home, "global/AGENTS.md")).toEqual({ text: "", hash: null });
    await writeInstructions(work, home, "global/AGENTS.md", "Everywhere.\n", null);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe("Everywhere.\n");
    await expect(readInstructions(work, home, "project/../../etc/CLAUDE.md")).rejects.toThrow("no instructions file");
    expect(existsSync(join(work, "photos", "CLAUDE.md"))).toBe(false);
  });
});
