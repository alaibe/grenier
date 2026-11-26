import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secretIn } from "@grenier/core";
import type { LocalServer, ServerChange } from "@grenier/core/api";
import { writeAtomically } from "@grenier/core/node";
import type { Store } from "@grenier/store";
import { APPS, type App, configPath, LABELS, type Where } from "./connect.ts";
import { CREDENTIAL_FLAG, claudeConfig, readJson } from "./installs.ts";
import { Refusal } from "./io.ts";

/** What the app shows in place of a key in a server's arguments or URL. */
export const MASK = "••••";

/** A server's name: letters, digits, `.`, `_` and `-`; `grenier` and `grenier-…` are Grenier's own. */
const NAME = /^[\w.-]{1,60}$/;

type Entry = Record<string, unknown>;
type Scope = LocalServer["scope"];

const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const names = (value: unknown) => (value && typeof value === "object" ? Object.keys(value as object) : []);

/** Its arguments with what looks like a key masked: `--token=x`, the word after `--token`, and anything key-shaped. */
export function maskArgs(args: string[]): string[] {
  return args.map((arg, at) => {
    if (CREDENTIAL_FLAG.test(arg) && arg.includes("=")) return `${arg.slice(0, arg.indexOf("=") + 1)}${MASK}`;
    const before = args[at - 1];
    if (before !== undefined && CREDENTIAL_FLAG.test(before) && !before.includes("=")) return MASK;
    return secretIn(arg) ? MASK : arg;
  });
}

/** Its URL with a password and key-shaped query values masked. */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return secretIn(url) ? MASK : url;
  }
  if (parsed.password) parsed.password = MASK;
  for (const [key] of [...parsed.searchParams]) {
    if (/key|token|secret|auth|password/i.test(key)) parsed.searchParams.set(key, MASK);
  }
  const shown = decodeURIComponent(parsed.toString());
  return secretIn(shown) ? MASK : shown;
}

function view(scope: Scope, where: string | null, name: string, entry: Entry, editable: boolean): LocalServer {
  const url = typeof entry.url === "string" ? entry.url : null;
  const transport = entry.type === "sse" ? "sse" : url ? "http" : "stdio";
  return {
    id: JSON.stringify([scope, where, name]),
    name,
    scope,
    where,
    grenier: name === "grenier",
    editable: editable && name !== "grenier",
    transport,
    command: typeof entry.command === "string" ? entry.command : null,
    args: maskArgs(strings(entry.args)),
    url: url && maskUrl(url),
    env: names(entry.env),
    headers: names(entry.headers),
  };
}

const serversOf = (config: Entry): Record<string, Entry> =>
  (config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {}) as Record<string, Entry>;

/** Codex's `[mcp_servers.<name>]` tables, enough to list them: command, args, url and the names of env. */
export function codexServers(text: string): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  let current: Entry | null = null;
  let inEnv = false;
  const value = (raw: string) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw.replace(/^'|'$/g, "");
    }
  };
  for (const line of text.split("\n")) {
    const table = /^\s*\[mcp_servers\.(?:"([^"]+)"|([^\].]+))(\.env)?\]\s*$/.exec(line);
    if (table) {
      const name = (table[1] ?? table[2]) as string;
      out[name] ??= {};
      current = out[name] as Entry;
      inEnv = Boolean(table[3]);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const pair = /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!current || !pair) continue;
    const [, key, raw] = pair as unknown as [string, string, string];
    if (inEnv) current.env = { ...((current.env as Entry) ?? {}), [key]: "" };
    else if (key === "env") {
      current.env = Object.fromEntries([...raw.matchAll(/([\w-]+)\s*=/g)].map((match) => [match[1] as string, ""]));
    } else current[key] = value(raw);
  }
  return out;
}

/** The projects Claude Code knows, each with its own servers, from ~/.claude.json. */
const projectsOf = (config: Entry) =>
  (config.projects && typeof config.projects === "object" ? config.projects : {}) as Record<string, Entry>;

/**
 * Every MCP server this person's agents get: Claude Code's for every project and per project, which are changed here;
 * the repositories' .mcp.json and the other apps', which are not. Grenier's installs of the team's are the team's.
 */
export async function localServers(store: Store, where: Where): Promise<LocalServer[]> {
  const config = readJson(claudeConfig(where.home));
  const team = new Set(
    (await store.approvals.list()).filter((a) => a.kind === "mcp").map((a) => String(a.settings.name ?? "")),
  );
  const out: LocalServer[] = [];
  for (const [name, entry] of Object.entries(serversOf(config))) {
    if (!team.has(name)) out.push(view("user", null, name, entry, true));
  }
  for (const [project, settings] of Object.entries(projectsOf(config)).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [name, entry] of Object.entries(serversOf(settings)))
      out.push(view("project", project, name, entry, true));
    const shared = join(project, ".mcp.json");
    if (!existsSync(shared)) continue;
    let file: Entry;
    try {
      file = readJson(shared);
    } catch {
      continue;
    }
    for (const [name, entry] of Object.entries(serversOf(file))) out.push(view("repo", project, name, entry, false));
  }
  for (const app of APPS.filter((name) => name !== "claude-code")) {
    const path = configPath(app, where.home, where.platform, where.env);
    if (!existsSync(path)) continue;
    let servers: Record<string, Entry>;
    try {
      servers = app === "codex" ? codexServers(readFileSync(path, "utf8")) : serversOf(readJson(path));
    } catch {
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) out.push(view("app", LABELS[app as App], name, entry, false));
  }
  return out;
}

/** The folders of the projects Claude Code knows, where a server can be added for one project. */
export function claudeProjects(where: Where): string[] {
  return Object.keys(projectsOf(readJson(claudeConfig(where.home)))).sort();
}

/** The servers object that holds a server of Claude Code's, for every project or for one. */
function holder(config: Entry, scope: Scope, project: string | null): Record<string, Entry> {
  if (scope === "user") {
    config.mcpServers = serversOf(config);
    return config.mcpServers as Record<string, Entry>;
  }
  const projects = projectsOf(config);
  if (!project || !projects[project]) throw new Refusal(`Claude Code knows no project ${project ?? ""}`);
  const settings = projects[project] as Entry;
  settings.mcpServers = serversOf(settings);
  return settings.mcpServers as Record<string, Entry>;
}

function parse(id: string): [Scope, string | null, string] {
  try {
    const [scope, where, name] = JSON.parse(id) as [Scope, string | null, string];
    return [scope, where, name];
  } catch {
    throw new Refusal(`there is no server ${id}`);
  }
}

/** One of Claude Code's servers to change: never Grenier's own, a repository's or another app's. */
function editable(where: Where, id: string): { config: Entry; servers: Record<string, Entry>; name: string } {
  const [scope, project, name] = parse(id);
  if (scope === "repo") throw new Refusal(`${name} is in ${project}/.mcp.json: change it in the repository`);
  if (scope === "app") throw new Refusal(`${name} is ${project}'s: change it there`);
  if (name === "grenier") throw new Refusal("Grenier's own server is added and removed in Settings");
  const config = readJson(claudeConfig(where.home));
  const servers = holder(config, scope, project);
  if (!servers[name]) throw new Refusal(`there is no server ${name} here`);
  return { config, servers, name };
}

const save = (where: Where, config: Entry) =>
  writeAtomically(claudeConfig(where.home), `${JSON.stringify(config, null, 2)}\n`);

/** Sets or removes the named values, keeping the rest: what is typed goes only into Claude Code's config. */
function changed(before: unknown, change: Record<string, string | null> | undefined): Record<string, string> | null {
  const out = { ...((before ?? {}) as Record<string, string>) };
  for (const [key, value] of Object.entries(change ?? {})) {
    if (!/^[\w-]{1,80}$/.test(key)) throw new Refusal(`${key} is not a name a variable or a header takes`);
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A masked argument or URL sent back as it was shown stands for the value it hides; a changed one must be whole. */
function unmasked(next: string, before: string, shown: string): string {
  if (next === shown) return before;
  if (next.includes(MASK)) throw new Refusal("type the key again in full, or leave it as it is shown");
  return next;
}

export function changeServer(where: Where, id: string, change: ServerChange): void {
  const { config, servers, name } = editable(where, id);
  const entry = { ...(servers[name] as Entry) };
  if (change.command !== undefined) {
    if (typeof entry.url === "string") throw new Refusal(`${name} is reached at a URL, not run as a command`);
    if (!change.command.trim()) throw new Refusal("a local server runs a command");
    entry.command = change.command.trim();
  }
  if (change.args !== undefined) {
    const before = strings(entry.args);
    const shown = maskArgs(before);
    entry.args = change.args.map((arg, at) => unmasked(arg, before[at] ?? "", shown[at] ?? ""));
  }
  if (change.url !== undefined) {
    if (typeof entry.url !== "string") throw new Refusal(`${name} runs as a command, not at a URL`);
    entry.url = unmasked(change.url.trim(), entry.url, maskUrl(entry.url));
  }
  for (const part of ["env", "headers"] as const) {
    if (change[part] === undefined) continue;
    const next = changed(entry[part], change[part]);
    if (next) entry[part] = next;
    else delete entry[part];
  }
  servers[name] = entry;
  save(where, config);
}

/** A new server in Claude Code's config, for every project or one; never over one of the same name. */
export function addServer(
  where: Where,
  input: { project?: string | null; name: string; entry: Entry },
): LocalServer["id"] {
  const name = input.name.trim();
  if (!NAME.test(name)) throw new Refusal("a server's name takes letters, digits, ., _ and -");
  if (name === "grenier" || name.startsWith("grenier-")) throw new Refusal("names starting with grenier are Grenier's");
  const scope: Scope = input.project ? "project" : "user";
  const config = readJson(claudeConfig(where.home));
  const servers = holder(config, scope, input.project ?? null);
  if (servers[name]) throw new Refusal(`there is a server named ${name} there already`);
  servers[name] = input.entry;
  save(where, config);
  return JSON.stringify([scope, input.project ?? null, name]);
}

export function removeServer(where: Where, id: string): void {
  const { config, servers, name } = editable(where, id);
  delete servers[name];
  save(where, config);
}

/** A server's entry from the app's form: a command and its arguments, or a URL, with the values the person typed. */
export function entryOf(input: {
  url?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  headers?: unknown;
}): Entry {
  const pairs = (value: unknown) =>
    Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url) {
    try {
      new URL(url);
    } catch (error) {
      throw new Refusal((error as Error).message);
    }
    const headers = pairs(input.headers);
    return { type: "http", url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Refusal("a server has a URL, or a command to run");
  const env = pairs(input.env);
  return { type: "stdio", command, args: strings(input.args), ...(Object.keys(env).length > 0 ? { env } : {}) };
}

/**
 * A server of this person's as the team would share it: each environment variable and header becomes a key each
 * teammate types, so none of this person's values leave; arguments and a URL that carry a key are refused.
 */
export function shareable(where: Where, id: string): { config: Entry; credentials: string[] } {
  const { servers, name } = editable(where, id);
  const entry = servers[name] as Entry;
  if (typeof entry.url === "string") {
    const headers = Object.fromEntries(
      names(entry.headers).map((header) => {
        const value = String((entry.headers as Entry)[header] ?? "");
        const key = header.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        return [header, /^bearer /i.test(value) ? `Bearer {${key}}` : `{${key}}`];
      }),
    );
    const credentials = Object.values(headers).map((template) => /\{(\w+)\}/.exec(template)?.[1] as string);
    return { config: { type: entry.type === "sse" ? "sse" : "http", url: entry.url, headers }, credentials };
  }
  return { config: { command: entry.command, args: strings(entry.args) }, credentials: names(entry.env) };
}
