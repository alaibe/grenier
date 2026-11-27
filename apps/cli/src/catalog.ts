import { posix } from "node:path";
import { secretIn } from "@grenier/core";
import type { FoundServer, FoundSkill } from "@grenier/core/api";
import { manifestField } from "@grenier/core/skill-manifest";
import { z } from "zod";
import { Refusal } from "./io.ts";
import { KEY_NAME, templateNames } from "./server-config.ts";
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, type SkillFiles, skillFromFiles, TOO_BIG } from "./skill-files.ts";

const SEARCH = "https://skills.sh/api/search";
const GITHUB = "https://api.github.com/repos";
const RAW = "https://raw.githubusercontent.com";
/** GitHub's owner and repository names; a repository is never `.` or `..`, which would climb out of the URL. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[\w.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{6,64}$/;
const MAX_RESULTS = 30;
const MAX_MANIFESTS = 20;

/** What each source answers, as Grenier reads it: anything else in an entry is skipped, never trusted. */
const SkillHit = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  source: z.string().optional(),
  installs: z.number().optional(),
});
const Commit = z.object({ sha: z.string().regex(COMMIT) });
const Tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })) });
/** A header or variable a server in the MCP Registry asks for: a fixed value, or a key each person enters. */
const Input = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
  default: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  type: z.string().optional(),
});
const Remote = z.object({ type: z.string(), url: z.string(), headers: z.array(Input).default([]) });
const Package = z.object({
  registryType: z.string(),
  identifier: z.string(),
  version: z.string().optional(),
  transport: z.object({ type: z.string() }),
  packageArguments: z.array(Input).default([]),
  environmentVariables: z.array(Input).default([]),
});
const Server = z.object({
  name: z.string(),
  version: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  websiteUrl: z.string().optional(),
  remotes: z.array(z.unknown()).default([]),
  packages: z.array(z.unknown()).default([]),
});
/** The entries of a list, each read on its own: one that doesn't fit is dropped, not the whole answer. */
const each = <T>(schema: z.ZodType<T>, items: unknown): T[] =>
  (Array.isArray(items) ? items : []).flatMap((item) => {
    const read = schema.safeParse(item);
    return read.success ? [read.data] : [];
  });

/** A request to the web, whose failure to get there is refused with what fetch said. */
function reach(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(url, init).catch((error: Error) => {
    throw new Refusal(error.message);
  });
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
  for (const { id, name, source, installs } of each(SkillHit, answer.skills)) {
    const repo = source || id.split("/").slice(0, 2).join("/");
    if (!REPO.test(repo)) continue;
    found.push({ id, name, source: repo, installs: installs ?? 0 });
  }
  return found.slice(0, MAX_RESULTS);
}

/** The skill named `name` in the GitHub repository `source`, from one commit, within a shared skill's limits. */
export async function fetchSkill(source: string, name: string, fetchImpl: typeof fetch = fetch): Promise<SkillFiles> {
  if (!REPO.test(source)) throw new Refusal("a skill's source is a GitHub repository, as owner/repo");
  const github = async <T>(path: string, schema: z.ZodType<T>, what: string): Promise<T> => {
    const response = await reach(fetchImpl, `${GITHUB}/${source}${path}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Refusal(`GitHub answered ${response.status} for ${source}`);
    const read = schema.safeParse(await response.json().catch(() => null));
    if (!read.success) throw new Refusal(`GitHub named no ${what} for ${source}`);
    return read.data;
  };
  const { sha } = await github("/commits/HEAD", Commit, "commit");
  const { tree } = await github(`/git/trees/${sha}?recursive=1`, Tree, "files");
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
    if (manifestField(await raw(`${prefix}SKILL.md`), "name") !== name && posix.basename(folder) !== name) continue;
    const inside = visible.filter((entry) => entry.path.startsWith(prefix));
    const bytes = inside.reduce((total, entry) => total + (entry.size ?? 0), 0);
    if (inside.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
      throw new Refusal(`${name} is too large: ${TOO_BIG}`);
    }
    const files: Record<string, string> = {};
    for (const entry of inside) files[entry.path.slice(prefix.length)] = await raw(entry.path);
    return skillFromFiles(files, posix.basename(folder));
  }
  throw new Refusal(`${source} holds no skill named ${name}`);
}

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

const named = (value: unknown): value is string => typeof value === "string" && KEY_NAME.test(value);
const variable = (name: string) => name.replace(/-/g, "_");

/** A remote entry: its URL and the headers, as templates naming what each person enters. */
function remoteConfig(remote: z.infer<typeof Remote>): Pick<FoundServer, "config" | "credentials"> | null {
  const type = remote.type === "sse" ? "sse" : remote.type === "streamable-http" ? "http" : null;
  if (!type || !/^https:\/\/[^{}\s]+$/.test(remote.url)) return null;
  const headers: Record<string, string> = {};
  const credentials: string[] = [];
  for (const header of remote.headers) {
    if (!named(header.name)) return null;
    const template = typeof header.value === "string" ? header.value : `{${variable(header.name)}}`;
    const names = templateNames(template);
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
function pinnedImage(identifier: string, version: string | undefined): string | null {
  const image = /[:@][^/]+$/.test(identifier) ? identifier : version ? `${identifier}:${version}` : null;
  if (!image || image.length > 300 || image.endsWith(":latest")) return null;
  return /^[a-z0-9][\w.-]*(:\d+)?(\/[\w.-]+)*(:[\w.+-]{1,128}|@sha256:[0-9a-f]{64})$/.test(image) ? image : null;
}

/** An npm, PyPI or Docker package run over stdio, pinned to its version; null when it needs what only a person can say. */
function packageConfig(pkg: z.infer<typeof Package>): Pick<FoundServer, "config" | "credentials"> | null {
  if (pkg.transport.type !== "stdio") return null;
  const image = pkg.registryType === "oci" ? pinnedImage(pkg.identifier, pkg.version) : null;
  const version = pkg.version ?? "";
  if (!image && (!/^[@\w./-]{1,200}$/.test(pkg.identifier) || !/^[\w.+-]{1,50}$/.test(version))) return null;
  const args: string[] = [];
  for (const arg of pkg.packageArguments) {
    const value = arg.value ?? arg.default ?? null;
    if (value === null) {
      if (arg.isRequired === true) return null;
      continue;
    }
    if (arg.type === "named" && arg.name) args.push(arg.name, value);
    else args.push(value);
  }
  const env: Record<string, string> = {};
  const credentials: string[] = [];
  for (const entry of pkg.environmentVariables) {
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
    `${REGISTRY}?${new URLSearchParams({ search: query, version: "latest", limit: String(MAX_RESULTS) })}`,
    {
      headers: { accept: "application/json" },
    },
  );
  if (!response.ok) throw new Refusal(`the MCP Registry answered ${response.status}`);
  const answer = (await response.json().catch(() => ({}))) as { servers?: unknown };
  const found: FoundServer[] = [];
  for (const { server } of each(z.object({ server: Server }), answer.servers)) {
    if (!named(server.name.replace(/[./]/g, "-"))) continue;
    const remotes = each(Remote, server.remotes);
    const packages = each(Package, server.packages);
    // Docker comes last: a person is likelier to have Node or uv than Docker running.
    const ordered = [
      ...packages.filter((pkg) => pkg.registryType !== "oci"),
      ...packages.filter((pkg) => pkg.registryType === "oci"),
    ];
    const shape = [...remotes.map(remoteConfig), ...ordered.map(packageConfig)].find((entry) => entry !== null);
    if (!shape) continue;
    if (secretIn(JSON.stringify(shape.config))) continue;
    found.push({
      name: server.name,
      title: server.title ?? server.name.split("/").at(-1) ?? "",
      description: (server.description ?? "").slice(0, 300),
      version: server.version,
      ...shape,
      website: server.websiteUrl ?? null,
    });
  }
  return found.slice(0, MAX_RESULTS);
}
