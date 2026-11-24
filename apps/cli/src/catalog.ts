import { posix } from "node:path";
import { secretIn } from "@grenier/core";
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, type SkillFiles, skillField, skillFromFiles } from "./installs.ts";
import { Refusal } from "./io.ts";

const SEARCH = "https://skills.sh/api/search";
const GITHUB = "https://api.github.com/repos";
const RAW = "https://raw.githubusercontent.com";
/** GitHub's owner and repository names; a repository is never `.` or `..`, which would climb out of the URL. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[\w.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{6,64}$/;
const MAX_RESULTS = 30;
const MAX_MANIFESTS = 20;

/** A request to the web, whose failure to get there is refused with what fetch said. */
function reach(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(url, init).catch((error: Error) => {
    throw new Refusal(error.message);
  });
}

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
  const response = await reach(fetchImpl, `${SEARCH}?${new URLSearchParams({ q: query })}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Refusal(`skills.sh answered ${response.status}`);
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

/** The skill named `name` in the GitHub repository `source`, from one commit, within a shared skill's limits. */
export async function fetchSkill(source: string, name: string, fetchImpl: typeof fetch = fetch): Promise<SkillFiles> {
  if (!REPO.test(source)) throw new Refusal("a skill's source is a GitHub repository, as owner/repo");
  const github = async <T>(path: string): Promise<T> => {
    const response = await reach(fetchImpl, `${GITHUB}/${source}${path}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Refusal(`GitHub answered ${response.status} for ${source}`);
    return (await response.json()) as T;
  };
  const { sha } = await github<{ sha: unknown }>("/commits/HEAD");
  if (typeof sha !== "string" || !COMMIT.test(sha)) throw new Refusal(`GitHub named no commit for ${source}`);
  const { tree } = await github<{ tree: { path: string; type: string; size?: number }[] }>(
    `/git/trees/${sha}?recursive=1`,
  );
  const raw = async (path: string) => {
    const response = await reach(
      fetchImpl,
      `${RAW}/${source}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (!response.ok) throw new Refusal(`GitHub answered ${response.status} for ${path}`);
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
      throw new Refusal(`${name} is larger than a shared skill may be: ${MAX_SKILL_FILES} files and 200 KB`);
    }
    const files: Record<string, string> = {};
    for (const entry of inside) files[entry.path.slice(prefix.length)] = await raw(entry.path);
    return skillFromFiles(files, posix.basename(folder));
  }
  throw new Refusal(`${source} holds no skill named ${name}`);
}

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

/** A server the MCP Registry lists, as the team would share it: pinned, with the names of the keys each person enters. */
export interface FoundServer {
  name: string;
  title: string;
  description: string;
  version: string;
  config: Record<string, unknown>;
  credentials: string[];
  website: string | null;
}

interface RegistryInput {
  name?: unknown;
  value?: unknown;
  default?: unknown;
  isRequired?: unknown;
  isSecret?: unknown;
  type?: unknown;
}

const named = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,80}$/.test(value);
const variable = (name: string) => name.replace(/-/g, "_");

/** A remote entry: its URL and the headers, as templates naming what each person enters. */
function remoteConfig(remote: Record<string, unknown>): Pick<FoundServer, "config" | "credentials"> | null {
  const type = remote.type === "sse" ? "sse" : remote.type === "streamable-http" ? "http" : null;
  if (!type || typeof remote.url !== "string" || !/^https:\/\/[^{}\s]+$/.test(remote.url)) return null;
  const headers: Record<string, string> = {};
  const credentials: string[] = [];
  for (const header of (Array.isArray(remote.headers) ? remote.headers : []) as RegistryInput[]) {
    if (!named(header.name)) return null;
    const template = typeof header.value === "string" ? header.value : `{${variable(header.name)}}`;
    const names = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
    if (names.length === 0 && header.isRequired === true) return null;
    headers[header.name] = template;
    credentials.push(...names);
  }
  return {
    config: { type, url: remote.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) },
    credentials: [...new Set(credentials)],
  };
}

/** A Docker image pinned by its tag or digest, which the Registry puts in the identifier or gives apart as the version. */
function pinnedImage(identifier: string, version: unknown): string | null {
  const image = /[:@][^/]+$/.test(identifier)
    ? identifier
    : typeof version === "string"
      ? `${identifier}:${version}`
      : null;
  if (!image || image.length > 300 || image.endsWith(":latest")) return null;
  return /^[a-z0-9][\w.-]*(:\d+)?(\/[\w.-]+)*(:[\w.+-]{1,128}|@sha256:[0-9a-f]{64})$/.test(image) ? image : null;
}

/** An npm, PyPI or Docker package run over stdio, pinned to its version; null when it needs what only a person can say. */
function packageConfig(pkg: Record<string, unknown>): Pick<FoundServer, "config" | "credentials"> | null {
  const transport = (pkg.transport ?? {}) as { type?: unknown };
  if (transport.type !== "stdio" || typeof pkg.identifier !== "string") return null;
  const image = pkg.registryType === "oci" ? pinnedImage(pkg.identifier, pkg.version) : null;
  const version = String(pkg.version ?? "");
  if (!image && (!/^[@\w./-]{1,200}$/.test(pkg.identifier) || !/^[\w.+-]{1,50}$/.test(version))) return null;
  const args: string[] = [];
  for (const arg of (Array.isArray(pkg.packageArguments) ? pkg.packageArguments : []) as RegistryInput[]) {
    const value = typeof arg.value === "string" ? arg.value : typeof arg.default === "string" ? arg.default : null;
    if (value === null) {
      if (arg.isRequired === true) return null;
      continue;
    }
    if (arg.type === "named" && typeof arg.name === "string") args.push(arg.name, value);
    else args.push(value);
  }
  const env: Record<string, string> = {};
  const credentials: string[] = [];
  for (const entry of (Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) as RegistryInput[]) {
    if (!named(entry.name)) return null;
    if (entry.isSecret === true || (entry.isRequired === true && typeof entry.default !== "string")) {
      credentials.push(entry.name);
    } else if (entry.isRequired === true && typeof entry.default === "string") env[entry.name] = entry.default;
  }
  // The image's own runtime arguments are left out: they could mount this machine's files into it.
  const forwarded = [...Object.keys(env), ...credentials].flatMap((name) => ["-e", name]);
  const run = image
    ? { command: "docker", args: ["run", "-i", "--rm", ...forwarded, image, ...args] }
    : pkg.registryType === "npm"
      ? { command: "npx", args: ["-y", `${pkg.identifier}@${version}`, ...args] }
      : pkg.registryType === "pypi"
        ? { command: "uvx", args: [`${pkg.identifier}==${version}`, ...args] }
        : null;
  if (!run) return null;
  return { config: { ...run, ...(Object.keys(env).length > 0 ? { env } : {}) }, credentials };
}

/** Servers the MCP Registry lists for the words, their latest version, that Grenier can share as they are. */
export async function searchServers(words: string, fetchImpl: typeof fetch = fetch): Promise<FoundServer[]> {
  const query = words.trim().slice(0, 200);
  if (!query) return [];
  const response = await reach(
    fetchImpl,
    `${REGISTRY}?${new URLSearchParams({ search: query, version: "latest", limit: "30" })}`,
    {
      headers: { accept: "application/json" },
    },
  );
  if (!response.ok) throw new Refusal(`the MCP Registry answered ${response.status}`);
  const answer = (await response.json().catch(() => ({}))) as { servers?: unknown };
  const found: FoundServer[] = [];
  for (const item of Array.isArray(answer.servers) ? answer.servers : []) {
    const server = ((item ?? {}) as { server?: Record<string, unknown> }).server ?? {};
    if (!named(String(server.name ?? "").replace(/[./]/g, "-")) || typeof server.version !== "string") continue;
    const remotes = (Array.isArray(server.remotes) ? server.remotes : []) as Record<string, unknown>[];
    const packages = (Array.isArray(server.packages) ? server.packages : []) as Record<string, unknown>[];
    // Docker comes last: a person is likelier to have Node or uv than Docker running.
    const ordered = [
      ...packages.filter((pkg) => pkg.registryType !== "oci"),
      ...packages.filter((pkg) => pkg.registryType === "oci"),
    ];
    const shape = [...remotes.map(remoteConfig), ...ordered.map(packageConfig)].find((entry) => entry !== null);
    if (!shape) continue;
    if (secretIn(JSON.stringify(shape.config))) continue;
    found.push({
      name: String(server.name),
      title: typeof server.title === "string" ? server.title : (String(server.name).split("/").at(-1) ?? ""),
      description: typeof server.description === "string" ? server.description.slice(0, 300) : "",
      version: server.version,
      ...shape,
      website: typeof server.websiteUrl === "string" ? server.websiteUrl : null,
    });
  }
  return found.slice(0, MAX_RESULTS);
}
