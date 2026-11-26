import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { InstructionFile, InstructionText } from "@grenier/core/api";
import { writeAtomically } from "@grenier/core/node";
import { sha256 } from "@grenier/core/policy";
import { AGENT_TEXTS, type AgentTexts } from "@grenier/gateway";
import { agentTextPath, GRENIER_TEXTS } from "./agent-texts.ts";
import { AGENTS, type Where } from "./agents/index.ts";
import { isDir, Refusal } from "./io.ts";

/** The files a project's agents read: Claude Code's, everyone else's, and Claude Code's kept out of git. */
const PROJECT_FILES = ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md"] as const;

/** Where the instructions files are: the work folder's projects, each agent's home and Grenier's own folder. */
export interface Places {
  workdir: string;
  where: Where;
  grenierHome: string;
}

/** The projects in the work folder: its folders that are a git repository or hold an instructions file. */
function projects(workdir: string): string[] {
  if (!workdir || !isDir(workdir)) return [];
  return readdirSync(workdir)
    .filter((name) => !name.startsWith(".") && isDir(join(workdir, name)))
    .filter(
      (name) =>
        existsSync(join(workdir, name, ".git")) || PROJECT_FILES.some((file) => existsSync(join(workdir, name, file))),
    )
    .sort((a, b) => a.localeCompare(b));
}

/** Every instructions file agents read here, whether it exists yet or not, and the texts Grenier gives them. */
export function instructionFiles(places: Places): InstructionFile[] {
  const file = (id: string, name: string, group: InstructionFile["group"], project: string | null, path: string) => ({
    id,
    name,
    group,
    project,
    path,
    exists: existsSync(path),
  });
  return [
    ...AGENTS.map((agent) => {
      const path = agent.globalInstructions(places.where);
      return file(`global/${basename(path)}`, basename(path), "every", null, path);
    }),
    ...projects(places.workdir).flatMap((project) =>
      PROJECT_FILES.map((name) =>
        file(`project/${project}/${name}`, name, "project", project, join(places.workdir, project, name)),
      ),
    ),
    ...(Object.entries(GRENIER_TEXTS) as [keyof AgentTexts, { label: string }][]).map(([key, { label }]) =>
      file(`grenier/${key}`, label, "grenier", null, agentTextPath(places.grenierHome, key)),
    ),
  ];
}

/** The path of a file by its id: only the files the list names, never another path. */
function pathOf(places: Places, id: string): string {
  const file = instructionFiles(places).find((entry) => entry.id === id);
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
