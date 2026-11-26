import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { LocalSkill, LocalSkillFull } from "@grenier/core/api";
import { writeAtomically } from "@grenier/core/node";
import type { Store } from "@grenier/store";
import { type Agent, agentNamed, CLAUDE_CODE, presentAgents, readJson, type Where } from "./agents/index.ts";
import { isDir, Refusal } from "./io.ts";
import {
  BAD_NAME,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  SKILL_NAME,
  type SkillFiles,
  skillField,
  TOO_BIG,
  writeSkill,
} from "./skill-files.ts";

function described(
  agent: Agent,
  id: string,
  folder: string,
  kind: LocalSkill["kind"],
  path = folder,
): LocalSkill | null {
  const manifest = join(folder, "SKILL.md");
  if (!existsSync(manifest)) return null;
  const text = readFileSync(manifest, "utf8");
  const name = skillField(text, "name") ?? id.split(/[:/]/).pop() ?? id;
  return { id, agent: agent.label, name, description: skillField(text, "description") ?? "", kind, path };
}

/** The skills in a folder that holds one folder per skill. */
function skillsIn(agent: Agent, folder: string, prefix: string, kind: LocalSkill["kind"]): LocalSkill[] {
  if (!isDir(folder)) return [];
  return readdirSync(folder)
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => described(agent, `${prefix}${name}`, join(folder, name), kind) ?? []);
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
 * Every skill this person's agents load, agent by agent: their own folders and links in its skills folder, and for
 * Claude Code the ones synced from claude.ai and the plugins'. Grenier's installs of the team's are the team's list.
 */
export async function localSkills(store: Store, where: Where): Promise<LocalSkill[]> {
  const team = new Set(
    (await store.approvals.list()).filter((approval) => approval.kind === "skill").map((a) => String(a.settings.name)),
  );
  const out: LocalSkill[] = [];
  for (const agent of presentAgents(where)) {
    const dir = agent.skillsDir(where);
    const prefix = `${agent.agent}:`;
    if (isDir(dir)) {
      for (const name of readdirSync(dir).sort()) {
        const folder = join(dir, name);
        if (name.startsWith(".") || name === "synced" || team.has(name)) continue;
        const linked = lstatSync(folder).isSymbolicLink();
        const skill = linked
          ? described(agent, `${prefix}${name}`, folder, "linked", isDir(folder) ? realpathSync(folder) : folder)
          : described(agent, `${prefix}${name}`, folder, "own");
        if (skill) out.push(skill);
      }
    }
    if (agent !== CLAUDE_CODE) continue;
    const synced = join(dir, "synced");
    if (isDir(synced)) {
      for (const bucket of readdirSync(synced).filter((name) => !name.startsWith("."))) {
        out.push(...skillsIn(agent, join(synced, bucket), `${prefix}synced/${bucket}/`, "synced"));
      }
    }
    for (const [plugin, path] of pluginFolders(where.home)) {
      out.push(...skillsIn(agent, join(path, "skills"), `${prefix}plugin/${plugin}/`, "plugin"));
    }
  }
  return out;
}

async function found(store: Store, where: Where, id: string): Promise<LocalSkill> {
  const skill = (await localSkills(store, where)).find((entry) => entry.id === id);
  if (!skill) throw new Refusal(`there is no skill ${id} in your skills`);
  return skill;
}

/** A skill's folder, as its agent finds it: a link's own path, not its target's. */
function folderOf(where: Where, skill: LocalSkill): string {
  if (skill.kind !== "own" && skill.kind !== "linked") return skill.path;
  const [agent = "", name = ""] = skill.id.split(":");
  return join(agentNamed(agent).skillsDir(where), name);
}

/** The files under a folder, by their path in it with `/` between parts, leaving out hidden ones. */
function filesIn(folder: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(at, name);
      if (isDir(path)) walk(path);
      else out.push(relative(folder, path).split("\\").join("/"));
    }
  };
  walk(folder);
  return out;
}

/** The text files of a skill's folder, by their path in it, within a shared skill's limits. */
export function skillFilesIn(folder: string): Record<string, string> {
  const paths = filesIn(folder);
  if (paths.length > MAX_SKILL_FILES) throw new Refusal(TOO_BIG);
  const files = Object.fromEntries(paths.map((path) => [path, readFileSync(join(folder, path), "utf8")]));
  const bytes = Object.values(files).reduce((total, text) => total + Buffer.byteLength(text), 0);
  if (bytes > MAX_SKILL_BYTES) throw new Refusal(TOO_BIG);
  return files;
}

export async function localSkill(store: Store, where: Where, id: string): Promise<LocalSkillFull> {
  const skill = await found(store, where, id);
  const folder = folderOf(where, skill);
  return {
    ...skill,
    manifest: readFileSync(join(folder, "SKILL.md"), "utf8"),
    files: filesIn(folder).filter((path) => path !== "SKILL.md"),
  };
}

/** A new skill of the person's own, a folder named after it in every agent's skills here, never over one there. */
export function addLocalSkill(where: Where, skill: SkillFiles): string {
  const name = skill.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  if (!SKILL_NAME.test(name)) throw new Refusal(BAD_NAME);
  const agents = presentAgents(where);
  if (agents.some((agent) => existsSync(join(agent.skillsDir(where), name)))) {
    throw new Refusal(`there is a skill named ${name} in your skills already`);
  }
  for (const agent of agents) writeSkill(join(agent.skillsDir(where), name), skill.files);
  return `${agents[0]?.agent ?? CLAUDE_CODE.agent}:${name}`;
}

/** A new SKILL.md for one of the person's own skills; a link, a synced or a plugin's skill is changed where it comes from. */
export async function saveLocalSkill(store: Store, where: Where, id: string, manifest: string): Promise<void> {
  const skill = await found(store, where, id);
  if (skill.kind !== "own") throw new Refusal(`${skill.name} is kept elsewhere (${skill.path}): change it there`);
  if (!manifest.startsWith("---\n")) throw new Refusal("a SKILL.md starts with its front matter, between --- lines");
  writeAtomically(join(folderOf(where, skill), "SKILL.md"), manifest);
}

/** Takes a skill out of the person's skills: their own folder goes, a link goes without what it points to. */
export async function removeLocalSkill(store: Store, where: Where, id: string): Promise<void> {
  const skill = await found(store, where, id);
  if (skill.kind === "synced" || skill.kind === "plugin") {
    throw new Refusal(`${skill.name} comes with ${skill.kind === "synced" ? "your claude.ai account" : "a plugin"}`);
  }
  const folder = folderOf(where, skill);
  if (skill.kind === "linked") unlinkSync(folder);
  else rmSync(folder, { recursive: true });
}
