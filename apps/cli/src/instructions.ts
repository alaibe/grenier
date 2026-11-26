import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InstructionFile, InstructionText } from "@grenier/core/api";
import { writeAtomically } from "@grenier/core/node";
import { sha256 } from "@grenier/core/policy";
import { AGENT_TEXTS, type AgentTexts } from "@grenier/gateway";
import { agentTextPath } from "./agent-texts.ts";
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

/** The texts Grenier gives agents, by how the list names them. */
const GRENIER_TEXTS: Record<keyof AgentTexts, string> = {
  run: "grenier run",
  mcp: "MCP server",
  get: "get",
  set: "set",
};

/** Every instructions file agents read here, whether it exists yet or not, and the texts Grenier gives them. */
export function instructionFiles(workdir: string, home: string, grenierHome: string): InstructionFile[] {
  const out: InstructionFile[] = Object.entries(globalFiles(home)).map(([name, path]) => ({
    id: `global/${name}`,
    name,
    group: "every",
    project: null,
    path,
    exists: existsSync(path),
  }));
  for (const project of projects(workdir, home)) {
    for (const name of PROJECT_FILES) {
      const path = join(workFolder(workdir, home), project, name);
      out.push({ id: `project/${project}/${name}`, name, group: "project", project, path, exists: existsSync(path) });
    }
  }
  for (const [key, name] of Object.entries(GRENIER_TEXTS) as [keyof AgentTexts, string][]) {
    const path = agentTextPath(grenierHome, key);
    out.push({ id: `grenier/${key}`, name, group: "grenier", project: null, path, exists: existsSync(path) });
  }
  return out;
}

/** Where the instructions files are: the work folder's projects, the person's home and Grenier's own folder. */
export interface Places {
  workdir: string;
  home: string;
  grenierHome: string;
}

/** The path of a file by its id: only the files the list names, never another path. */
function pathOf(places: Places, id: string): string {
  const file = instructionFiles(places.workdir, places.home, places.grenierHome).find((entry) => entry.id === id);
  if (!file) throw new Refusal(`there is no instructions file ${id}`);
  return file.path;
}

/** A file's text; for one of Grenier's texts not changed yet, Grenier's own, with no hash. */
export async function readInstructions(places: Places, id: string): Promise<InstructionText> {
  const path = pathOf(places, id);
  if (!existsSync(path)) {
    const key = id.startsWith("grenier/") ? (id.slice("grenier/".length) as keyof AgentTexts) : null;
    return { text: key ? `${AGENT_TEXTS[key]}\n` : "", hash: null };
  }
  const text = readFileSync(path, "utf8");
  return { text, hash: await sha256(text) };
}

/** Writes a file, or makes it, unless it changed since it was read: `hash` is what the person started from. */
export async function writeInstructions(
  places: Places,
  id: string,
  text: string,
  hash: string | null,
): Promise<InstructionText> {
  const path = pathOf(places, id);
  const now = existsSync(path) ? await sha256(readFileSync(path, "utf8")) : null;
  if (now !== hash) throw new Refusal("it changed on disk since you opened it: reload it, then make your change again");
  mkdirSync(dirname(path), { recursive: true });
  writeAtomically(path, text);
  return { text, hash: await sha256(text) };
}

/** Puts back the text Grenier ships, for one of its texts: the person's version goes. */
export function resetInstructions(places: Places, id: string): void {
  if (!id.startsWith("grenier/")) throw new Refusal("only a text Grenier gives agents goes back to Grenier's own");
  rmSync(pathOf(places, id), { force: true });
}
