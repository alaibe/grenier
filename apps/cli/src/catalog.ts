import { posix } from "node:path";
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, type SkillFiles, skillField, skillFromFiles } from "./installs.ts";
import { CommandError } from "./io.ts";

const SEARCH = "https://skills.sh/api/search";
const GITHUB = "https://api.github.com/repos";
const RAW = "https://raw.githubusercontent.com";
/** GitHub's owner and repository names; a repository is never `.` or `..`, which would climb out of the URL. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[\w.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{6,64}$/;
const MAX_RESULTS = 30;
const MAX_MANIFESTS = 20;

/** A skill skills.sh lists: `source` is the GitHub repository that holds it. */
export interface FoundSkill {
  id: string;
  name: string;
  source: string;
  installs: number;
}

/** Skills on skills.sh that match the words; only the words are sent. */
export async function searchSkills(words: string, fetchImpl: typeof fetch = fetch): Promise<FoundSkill[]> {
  const query = words.trim().slice(0, 200);
  if (!query) return [];
  const response = await fetchImpl(`${SEARCH}?${new URLSearchParams({ q: query })}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new CommandError(`skills.sh answered ${response.status}`);
  const answer = (await response.json().catch(() => ({}))) as { skills?: unknown };
  const found: FoundSkill[] = [];
  for (const entry of Array.isArray(answer.skills) ? answer.skills : []) {
    const { id, name, source, installs } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || !name || name.length > 100) continue;
    const repo = typeof source === "string" && source ? source : id.split("/").slice(0, 2).join("/");
    if (!REPO.test(repo)) continue;
    found.push({ id, name, source: repo, installs: typeof installs === "number" ? installs : 0 });
  }
  return found.slice(0, MAX_RESULTS);
}

/**
 * The skill named `name` in the GitHub repository `source`, from one commit: the folder whose SKILL.md names it, with
 * every text file in it but hidden ones, within a shared skill's limits.
 */
export async function fetchSkill(source: string, name: string, fetchImpl: typeof fetch = fetch): Promise<SkillFiles> {
  if (!REPO.test(source)) throw new CommandError("a skill's source is a GitHub repository, as owner/repo");
  const github = async <T>(path: string): Promise<T> => {
    const response = await fetchImpl(`${GITHUB}/${source}${path}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new CommandError(`GitHub answered ${response.status} for ${source}`);
    return (await response.json()) as T;
  };
  const { sha } = await github<{ sha: unknown }>("/commits/HEAD");
  if (typeof sha !== "string" || !COMMIT.test(sha)) throw new CommandError(`GitHub named no commit for ${source}`);
  const { tree } = await github<{ tree: { path: string; type: string; size?: number }[] }>(
    `/git/trees/${sha}?recursive=1`,
  );
  const raw = async (path: string) => {
    const response = await fetchImpl(`${RAW}/${source}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`);
    if (!response.ok) throw new CommandError(`GitHub answered ${response.status} for ${path}`);
    return response.text();
  };
  const visible = tree.filter(
    (entry) => entry.type === "blob" && !entry.path.split("/").some((part) => part.startsWith(".")),
  );
  const folders = visible
    .filter((entry) => posix.basename(entry.path) === "SKILL.md")
    .map((entry) => posix.dirname(entry.path))
    .sort((a, b) => Number(posix.basename(b) === name) - Number(posix.basename(a) === name));
  for (const folder of folders.slice(0, MAX_MANIFESTS)) {
    const prefix = folder === "." ? "" : `${folder}/`;
    if (skillField(await raw(`${prefix}SKILL.md`), "name") !== name && posix.basename(folder) !== name) continue;
    const inside = visible.filter((entry) => entry.path.startsWith(prefix));
    const bytes = inside.reduce((total, entry) => total + (entry.size ?? 0), 0);
    if (inside.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
      throw new CommandError(`${name} is larger than a shared skill may be: ${MAX_SKILL_FILES} files and 200 KB`);
    }
    const files: Record<string, string> = {};
    for (const entry of inside) files[entry.path.slice(prefix.length)] = await raw(entry.path);
    return skillFromFiles(files, posix.basename(folder));
  }
  throw new CommandError(`${source} holds no skill named ${name}`);
}
