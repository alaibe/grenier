import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TEXTS } from "@grenier/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentTexts } from "../../../apps/cli/src/agent-texts.ts";
import {
  instructionFiles,
  type Places,
  readInstructions,
  resetInstructions,
  writeInstructions,
} from "../../../apps/cli/src/instructions.ts";

let home: string;
let work: string;
let places: Places;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "grenier-instructions-"));
  work = join(home, "Work");
  places = {
    workdir: work,
    where: { home, platform: "linux", env: {}, self: [] },
    grenierHome: join(home, ".grenier"),
  };
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
  it("lists every agent's own, each project's in the work folder, and Grenier's texts, made yet or not", () => {
    const files = instructionFiles(places);
    expect(files.map((file) => [file.id, file.exists])).toEqual([
      ["global/CLAUDE.md", true],
      ["global/AGENTS.md", false],
      ["project/checkout/CLAUDE.md", false],
      ["project/checkout/AGENTS.md", true],
      ["project/checkout/CLAUDE.local.md", false],
      ["project/notes/CLAUDE.md", true],
      ["project/notes/AGENTS.md", false],
      ["project/notes/CLAUDE.local.md", false],
      ["grenier/mcp", false],
      ["grenier/get", false],
      ["grenier/set", false],
    ]);
    expect(instructionFiles({ ...places, workdir: "" }).filter((file) => file.group !== "grenier")).toHaveLength(2);
  });

  it("writes one, makes a new one, and never over a change made since it was read", async () => {
    const read = await readInstructions(places, "project/checkout/AGENTS.md");
    expect(read.text).toBe("# Checkout\n");
    const saved = await writeInstructions(
      places,
      "project/checkout/AGENTS.md",
      "# Checkout\n\nRun pnpm test.\n",
      read.hash,
    );
    expect(readFileSync(join(work, "checkout", "AGENTS.md"), "utf8")).toBe("# Checkout\n\nRun pnpm test.\n");

    writeFileSync(join(work, "checkout", "AGENTS.md"), "An agent's change.\n");
    await expect(writeInstructions(places, "project/checkout/AGENTS.md", "Mine.\n", saved.hash)).rejects.toThrow(
      "changed on disk",
    );
    expect(readFileSync(join(work, "checkout", "AGENTS.md"), "utf8")).toBe("An agent's change.\n");

    expect(await readInstructions(places, "global/AGENTS.md")).toEqual({ text: "", hash: null });
    await writeInstructions(places, "global/AGENTS.md", "Everywhere.\n", null);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe("Everywhere.\n");
    await expect(readInstructions(places, "project/../../etc/CLAUDE.md")).rejects.toThrow("no instructions file");
    expect(existsSync(join(work, "photos", "CLAUDE.md"))).toBe(false);
  });

  it("shows Grenier's own text until the person writes theirs, which agents then get, and puts it back", async () => {
    expect(await readInstructions(places, "grenier/get")).toEqual({ text: `${AGENT_TEXTS.get}\n`, hash: null });
    await writeInstructions(places, "grenier/get", "Search the store first.\n", null);
    expect(agentTexts(places.grenierHome)).toEqual({ get: "Search the store first." });
    resetInstructions(places, "grenier/get");
    expect(agentTexts(places.grenierHome)).toEqual({});
    expect(() => resetInstructions(places, "global/CLAUDE.md")).toThrow("only a text Grenier gives");
  });
});
