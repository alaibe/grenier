import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InstructionFile, InstructionText } from "@grenier/core/api";
import { writeAtomically } from "@grenier/core/node";
import { sha256 } from "@grenier/core/policy";
import { Refusal } from "./io.ts";

/** The files a project's agents read: Claude Code's, everyone else's, and Claude Code's kept out of git. */
const PROJECT_FILES = ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md"] as const;

/** The files every project's agents read, by agent. */
const globalFiles = (home: string) => ({
  "CLAUDE.md": join(home, ".claude", "CLAUDE.md"),
  "AGENTS.md": join(home, ".codex", "AGENTS.md"),
});

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The work folder as Settings has it, with a leading ~ for the home folder. */
const workFolder = (workdir: string, home: string) =>
  workdir.startsWith("~/") ? join(home, workdir.slice(2)) : workdir;

/** The projects in the work folder: its folders that are a git repository or hold an instructions file. */
function projects(workdir: string, home: string): string[] {
  const folder = workFolder(workdir, home);
  if (!workdir || !isDir(folder)) return [];
  return readdirSync(folder)
    .filter((name) => !name.startsWith(".") && isDir(join(folder, name)))
    .filter(
      (name) =>
        existsSync(join(folder, name, ".git")) || PROJECT_FILES.some((file) => existsSync(join(folder, name, file))),
    )
    .sort((a, b) => a.localeCompare(b));
}

/** Every instructions file agents read here, whether it exists yet or not. */
export function instructionFiles(workdir: string, home: string): InstructionFile[] {
  const out: InstructionFile[] = Object.entries(globalFiles(home)).map(([name, path]) => ({
    id: `global/${name}`,
    name,
    project: null,
    path,
    exists: existsSync(path),
  }));
  for (const project of projects(workdir, home)) {
    for (const name of PROJECT_FILES) {
      const path = join(workFolder(workdir, home), project, name);
      out.push({ id: `project/${project}/${name}`, name, project, path, exists: existsSync(path) });
    }
  }
  return out;
}

/** The path of a file by its id: only the files the list names, never another path. */
function pathOf(workdir: string, home: string, id: string): string {
  const file = instructionFiles(workdir, home).find((entry) => entry.id === id);
  if (!file) throw new Refusal(`there is no instructions file ${id}`);
  return file.path;
}

export async function readInstructions(workdir: string, home: string, id: string): Promise<InstructionText> {
  const path = pathOf(workdir, home, id);
  if (!existsSync(path)) return { text: "", hash: null };
  const text = readFileSync(path, "utf8");
  return { text, hash: await sha256(text) };
}

/** Writes a file, or makes it, unless it changed since it was read: `hash` is what the person started from. */
export async function writeInstructions(
  workdir: string,
  home: string,
  id: string,
  text: string,
  hash: string | null,
): Promise<InstructionText> {
  const path = pathOf(workdir, home, id);
  const now = existsSync(path) ? await sha256(readFileSync(path, "utf8")) : null;
  if (now !== hash) throw new Refusal("it changed on disk since you opened it: reload it, then make your change again");
  mkdirSync(dirname(path), { recursive: true });
  writeAtomically(path, text);
  return { text, hash: await sha256(text) };
}
