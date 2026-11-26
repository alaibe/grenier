import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { Refusal } from "./io.ts";

/** What a skill's folder is named: lowercase letters, digits and dashes, as Claude Code names skills. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BAD_NAME = "a skill's name takes lowercase letters, digits and -";

export const MAX_SKILL_BYTES = 200_000;
export const MAX_SKILL_FILES = 50;
/** What a shared skill may hold, as a refusal says it. */
export const TOO_BIG = `a shared skill holds at most ${MAX_SKILL_FILES} files and 200 KB`;

export interface SkillFiles {
  name: string;
  description: string;
  files: Record<string, string>;
}

/** A field of SKILL.md's front matter, as `name` or `description`, plain or in YAML's quotes. */
export function skillField(manifest: string, key: string): string | undefined {
  const front = /^---\n([\s\S]*?)\n---/.exec(manifest)?.[1] ?? "";
  const value = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim();
  // A block scalar, `>` or `|`: the indented lines under the key, folded into one for `>`.
  if (value && /^[>|][-+]?$/.test(value)) {
    const lines = new RegExp(`^${key}:.*\\n((?:[ \\t]+.*(?:\\n|$))+)`, "m").exec(front)?.[1] ?? "";
    const kept = lines.split("\n").map((line) => line.trim());
    return (value.startsWith(">") ? kept.join(" ") : kept.join("\n")).trim();
  }
  if (value && value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value && value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/** A skill as a record holds it, SKILL.md and the text files beside it, within a shared skill's limits. */
export function skillFromFiles(files: Record<string, string>, folderName: string): SkillFiles {
  const manifest = files["SKILL.md"];
  if (manifest === undefined) throw new Refusal("a skill has a SKILL.md");
  let bytes = 0;
  for (const [path, text] of Object.entries(files)) {
    if (text.includes("\u0000")) throw new Refusal(`${path} is not a text file; a shared skill holds text only`);
    bytes += Buffer.byteLength(text);
  }
  if (bytes > MAX_SKILL_BYTES || Object.keys(files).length > MAX_SKILL_FILES) throw new Refusal(TOO_BIG);
  const name = skillField(manifest, "name") ?? (folderName || "skill");
  return { name, description: skillField(manifest, "description") ?? "", files };
}

/** A path a skill's file may take inside its folder: relative, without `..`, and `/` its only separator. */
function safePath(path: string): string {
  const normal = posix.normalize(path);
  if (isAbsolute(normal) || normal.startsWith("..") || /[\0\\]/.test(normal) || normal === ".") {
    throw new Refusal(`the skill's file ${path} would land outside its folder`);
  }
  return normal;
}

/** A skill's folder, written anew with these files; a script among them stays runnable. */
export function writeSkill(folder: string, files: Record<string, string>): void {
  const entries = Object.entries(files).map(([path, text]) => [safePath(path), text] as const);
  rmSync(folder, { recursive: true, force: true });
  for (const [path, text] of entries) {
    const target = join(folder, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
    if (text.startsWith("#!")) chmodSync(target, 0o755);
  }
}

/** A SKILL.md from a name, a one-line description and the instructions. */
export function manifestOf(input: { name: string; description: string; instructions: string }): string {
  if (!SKILL_NAME.test(input.name)) throw new Refusal(BAD_NAME);
  if (!input.description.trim() || !input.instructions.trim()) {
    throw new Refusal("a skill needs a description and its instructions");
  }
  // A JSON string is a YAML double-quoted scalar: a ": " or a quote in it stays text.
  const description = JSON.stringify(input.description.trim().replace(/\s+/g, " "));
  return `---\nname: ${input.name}\ndescription: ${description}\n---\n${input.instructions.trim()}\n`;
}

/** A new skill from the app's form or the CLI: its name, when to use it, and its instructions. */
export function skillFromForm(input: Record<string, unknown>): SkillFiles {
  const name = String(input.name ?? "").trim();
  const manifest = manifestOf({
    name,
    description: String(input.description ?? ""),
    instructions: String(input.instructions ?? ""),
  });
  return skillFromFiles({ "SKILL.md": manifest }, name);
}
