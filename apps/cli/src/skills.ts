import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { LocalSkill, LocalSkillFull } from "@grenier/core/api";
import { writeAtomically } from "@grenier/core/node";
import type { Store } from "@grenier/store";
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, readJson, type SkillFiles, skillField, writeSkill } from "./installs.ts";
import { Refusal } from "./io.ts";

/** What a skill's folder is named: lowercase letters, digits and dashes, as Claude Code names skills. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const skillsDir = (home: string) => join(home, ".claude", "skills");
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function described(id: string, folder: string, kind: LocalSkill["kind"], path = folder): LocalSkill | null {
  const manifest = join(folder, "SKILL.md");
  if (!existsSync(manifest)) return null;
  const text = readFileSync(manifest, "utf8");
  const name = skillField(text, "name") ?? id.split("/").pop() ?? id;
  return { id, name, description: skillField(text, "description") ?? "", kind, path };
}

/** The skills in a folder that holds one folder per skill. */
function skillsIn(folder: string, prefix: string, kind: LocalSkill["kind"]): LocalSkill[] {
  if (!isDir(folder)) return [];
  return readdirSync(folder)
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => described(`${prefix}${name}`, join(folder, name), kind) ?? []);
}

/** Where each installed plugin is, from Claude Code's own list of them. */
function pluginFolders(home: string): [string, string][] {
  const file = join(home, ".claude", "plugins", "installed_plugins.json");
  let plugins: unknown;
  try {
    plugins = readJson(file).plugins;
  } catch {
    return [];
  }
  if (!plugins || typeof plugins !== "object") return [];
  return Object.entries(plugins as Record<string, unknown>).flatMap(([name, installs]) =>
    (Array.isArray(installs) ? installs : [installs]).flatMap((entry) => {
      const path = (entry as { installPath?: unknown } | null)?.installPath;
      return typeof path === "string" ? [[name.split("@")[0] ?? name, path] as [string, string]] : [];
    }),
  );
}

/**
 * Every skill Claude Code loads for this person: their own folders and links in ~/.claude/skills, the ones synced from
 * claude.ai, and the plugins'. Grenier's installs of the team's skills are left to the team's list.
 */
export async function localSkills(store: Store, home: string): Promise<LocalSkill[]> {
  const dir = skillsDir(home);
  const team = new Set(
    (await store.approvals.list()).filter((approval) => approval.kind === "skill").map((a) => a.installedPath),
  );
  const out: LocalSkill[] = [];
  if (isDir(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const folder = join(dir, name);
      if (name.startsWith(".") || name === "synced" || team.has(folder)) continue;
      const linked = lstatSync(folder).isSymbolicLink();
      const skill = linked
        ? described(name, folder, "linked", isDir(folder) ? realpathSync(folder) : folder)
        : described(name, folder, "own");
      if (skill) out.push(skill);
    }
    const synced = join(dir, "synced");
    if (isDir(synced)) {
      for (const bucket of readdirSync(synced).filter((name) => !name.startsWith("."))) {
        out.push(...skillsIn(join(synced, bucket), `synced/${bucket}/`, "synced"));
      }
    }
  }
  for (const [plugin, path] of pluginFolders(home)) {
    out.push(...skillsIn(join(path, "skills"), `plugin/${plugin}/`, "plugin"));
  }
  return out;
}

async function found(store: Store, home: string, id: string): Promise<LocalSkill> {
  const skill = (await localSkills(store, home)).find((entry) => entry.id === id);
  if (!skill) throw new Refusal(`there is no skill ${id} in your skills`);
  return skill;
}

/** A skill's folder, as Claude Code finds it: a link's own path, not its target's. */
function folderOf(home: string, skill: LocalSkill): string {
  if (skill.kind === "own" || skill.kind === "linked") return join(skillsDir(home), skill.id);
  return skill.path;
}

/** The text files of a skill's folder, by their path in it, within a shared skill's limits. */
export function skillFilesIn(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (name.startsWith(".")) continue;
      const path = join(at, name);
      if (isDir(path)) {
        walk(path);
        continue;
      }
      const text = readFileSync(path, "utf8");
      bytes += Buffer.byteLength(text);
      if (Object.keys(files).length >= MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
        throw new Refusal(`a skill shared with the team holds at most ${MAX_SKILL_FILES} files and 200 KB`);
      }
      files[relative(folder, path).split("\\").join("/")] = text;
    }
  };
  walk(folder);
  return files;
}

export async function localSkill(store: Store, home: string, id: string): Promise<LocalSkillFull> {
  const skill = await found(store, home, id);
  const folder = folderOf(home, skill);
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(at, name);
      if (isDir(path)) walk(path);
      else files.push(relative(folder, path).split("\\").join("/"));
    }
  };
  walk(folder);
  return {
    ...skill,
    manifest: readFileSync(join(folder, "SKILL.md"), "utf8"),
    files: files.filter((path) => path !== "SKILL.md"),
  };
}

/** A new skill of the person's own: a folder named after it in ~/.claude/skills, never over one that is there. */
export function addLocalSkill(home: string, skill: SkillFiles): string {
  const name = skill.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  if (!SKILL_NAME.test(name)) throw new Refusal("a skill's name takes lowercase letters, digits and -");
  const folder = join(skillsDir(home), name);
  if (existsSync(folder)) throw new Refusal(`there is a skill named ${name} in your skills already`);
  writeSkill(folder, skill.files);
  return name;
}

/** A SKILL.md from a name, a one-line description and the instructions. */
export function manifestOf(input: { name: string; description: string; instructions: string }): string {
  if (!SKILL_NAME.test(input.name)) throw new Refusal("a skill's name takes lowercase letters, digits and -");
  if (!input.description.trim() || !input.instructions.trim()) {
    throw new Refusal("a skill needs a description and its instructions");
  }
  // A JSON string is a YAML double-quoted scalar: a ": " or a quote in it stays text.
  const description = JSON.stringify(input.description.trim().replace(/\s+/g, " "));
  return `---\nname: ${input.name}\ndescription: ${description}\n---\n${input.instructions.trim()}\n`;
}

/** A new SKILL.md for one of the person's own skills; a link, a synced or a plugin's skill is changed where it comes from. */
export async function saveLocalSkill(store: Store, home: string, id: string, manifest: string): Promise<void> {
  const skill = await found(store, home, id);
  if (skill.kind !== "own") throw new Refusal(`${skill.name} is kept elsewhere (${skill.path}): change it there`);
  if (!manifest.startsWith("---\n")) throw new Refusal("a SKILL.md starts with its front matter, between --- lines");
  writeAtomically(join(folderOf(home, skill), "SKILL.md"), manifest);
}

/** Takes a skill out of the person's skills: their own folder goes, a link goes without what it points to. */
export async function removeLocalSkill(store: Store, home: string, id: string): Promise<void> {
  const skill = await found(store, home, id);
  if (skill.kind === "synced" || skill.kind === "plugin") {
    throw new Refusal(`${skill.name} comes with ${skill.kind === "synced" ? "your claude.ai account" : "a plugin"}`);
  }
  const folder = folderOf(home, skill);
  if (skill.kind === "linked") unlinkSync(folder);
  else rmSync(folder, { recursive: true });
}
