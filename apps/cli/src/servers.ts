import { join } from "node:path";
import { secretIn } from "@grenier/core";
import type { LocalServer, ServerChange } from "@grenier/core/api";
import type { Store } from "@grenier/store";
import {
  type App,
  CLAUDE_CODE,
  CLIENTS,
  clientOf,
  isAgent,
  type McpClient,
  presentAgents,
  readJson,
  type ServerEntry,
  serversIn,
  type Where,
} from "./agents/index.ts";
import { Refusal } from "./io.ts";
import { BAD_SERVER_NAME, CREDENTIAL_FLAG, KEY_NAME, SERVER_NAME, templateNames } from "./server-config.ts";

/** What the app shows in place of a key in a server's arguments or URL. */
export const MASK = "••••";

type Entry = ServerEntry;
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

function view(client: McpClient, scope: Scope, where: string | null, name: string, entry: Entry): LocalServer {
  const url = typeof entry.url === "string" ? entry.url : null;
  const transport = entry.type === "sse" ? "sse" : url ? "http" : "stdio";
  return {
    id: serverId(client.id, scope, where, name),
    app: client.id,
    name,
    client: client.label,
    scope,
    where,
    grenier: name === "grenier",
    editable: isAgent(client) && scope !== "repo" && name !== "grenier",
    transport,
    command: typeof entry.command === "string" ? entry.command : null,
    args: maskArgs(strings(entry.args)),
    url: url && maskUrl(url),
    env: names(entry.env),
    headers: names(entry.headers),
  };
}

/**
 * Every MCP server this person's agents get: Claude Code's and Codex's, which are changed here, with Claude Code's
 * per project; the repositories' .mcp.json and the other apps', which are not. Grenier's installs of the team's are
 * the team's.
 */
export async function localServers(store: Store, where: Where): Promise<LocalServer[]> {
  const team = new Set(
    (await store.approvals.list()).filter((a) => a.kind === "mcp").map((a) => String(a.settings.name ?? "")),
  );
  const out: LocalServer[] = [];
  for (const client of CLIENTS) {
    let servers: Record<string, Entry>;
    try {
      servers = client.servers(where);
    } catch {
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) {
      if (!team.has(name)) out.push(view(client, "user", null, name, entry));
    }
  }
  let projects: Record<string, Record<string, unknown>>;
  try {
    projects = CLAUDE_CODE.projects(where);
  } catch {
    projects = {};
  }
  for (const [project, settings] of Object.entries(projects).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [name, entry] of Object.entries(serversIn(settings))) {
      out.push(view(CLAUDE_CODE, "project", project, name, entry));
    }
    let shared: Record<string, unknown>;
    try {
      shared = readJson(join(project, ".mcp.json"));
    } catch {
      continue;
    }
    for (const [name, entry] of Object.entries(serversIn(shared))) {
      out.push(view(CLAUDE_CODE, "repo", project, name, entry));
    }
  }
  return out;
}

/** The folders of the projects Claude Code knows, where a server can be added for one project. */
export function claudeProjects(where: Where): string[] {
  return Object.keys(CLAUDE_CODE.projects(where)).sort();
}

const serverId = (client: App, scope: Scope, where: string | null, name: string) =>
  JSON.stringify([client, scope, where, name]);

function parse(id: string): [App, Scope, string | null, string] {
  try {
    const [client, scope, where, name] = JSON.parse(id) as [App, Scope, string | null, string];
    return [client, scope, where, name];
  } catch {
    throw new Refusal(`there is no server ${id}`);
  }
}

/** An agent's server to change, in its own config or a Claude Code project's: never Grenier's, a repository's or another app's. */
function edit(where: Where, id: string, change: (servers: Record<string, Entry>, name: string) => void): void {
  const [clientId, scope, project, name] = parse(id);
  const client = clientOf(clientId);
  if (scope === "repo") throw new Refusal(`${name} is in ${project}/.mcp.json: change it in the repository`);
  if (!client || !isAgent(client)) throw new Refusal(`${name} is ${client?.label ?? clientId}'s: change it there`);
  if (name === "grenier") throw new Refusal("Grenier's own server is added and removed in Settings");
  const apply = (servers: Record<string, Entry>) => {
    if (!servers[name]) throw new Refusal(`there is no server ${name} here`);
    change(servers, name);
  };
  if (scope === "project") CLAUDE_CODE.editProject(where, project ?? "", apply);
  else client.editServers(where, apply);
}

/** Sets or removes the named values, keeping the rest: what is typed goes only into its agent's config. */
function changed(before: unknown, change: Record<string, string | null> | undefined): Record<string, string> | null {
  const out = { ...((before ?? {}) as Record<string, string>) };
  for (const [key, value] of Object.entries(change ?? {})) {
    if (!KEY_NAME.test(key)) throw new Refusal(`${key} is not a name a variable or a header takes`);
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
  edit(where, id, (servers, name) => {
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
  });
}

/** A new server for every agent here, or for one Claude Code project; never over one of the same name. */
export function addServer(
  where: Where,
  input: { project?: string | null; name: string; entry: Entry },
): LocalServer["id"] {
  const name = input.name.trim();
  if (!SERVER_NAME.test(name)) throw new Refusal(BAD_SERVER_NAME);
  if (name === "grenier") throw new Refusal("the name grenier is Grenier's own");
  const taken = () => {
    throw new Refusal(`there is a server named ${name} there already`);
  };
  if (input.project) {
    CLAUDE_CODE.editProject(where, input.project, (servers) => {
      if (servers[name]) taken();
      servers[name] = input.entry;
    });
    return serverId(CLAUDE_CODE.id, "project", input.project, name);
  }
  const agents = presentAgents(where);
  if (agents.some((agent) => agent.servers(where)[name])) taken();
  for (const agent of agents) {
    agent.editServers(where, (servers) => {
      servers[name] = input.entry;
    });
  }
  return serverId(agents[0]?.id ?? CLAUDE_CODE.id, "user", null, name);
}

export function removeServer(where: Where, id: string): void {
  edit(where, id, (servers, name) => {
    delete servers[name];
  });
}

/**
 * A server of this person's as the team would share it: each environment variable and header becomes a key each
 * teammate types, so none of this person's values leave; arguments and a URL that carry a key are refused.
 */
export function shareable(where: Where, id: string): { name: string; config: Entry; credentials: string[] } {
  const [clientId, scope, project, name] = parse(id);
  const client = clientOf(clientId);
  const servers =
    scope === "project" ? serversIn(CLAUDE_CODE.projects(where)[project ?? ""] ?? {}) : (client?.servers(where) ?? {});
  const entry = servers[name];
  if (!entry || name === "grenier") throw new Refusal(`there is no server ${name} to share`);
  if (typeof entry.url === "string") {
    const headers = Object.fromEntries(
      names(entry.headers).map((header) => {
        const value = String((entry.headers as Entry)[header] ?? "");
        const key = header.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        return [header, /^bearer /i.test(value) ? `Bearer {${key}}` : `{${key}}`];
      }),
    );
    const credentials = Object.values(headers).flatMap(templateNames);
    return { name, config: { type: entry.type === "sse" ? "sse" : "http", url: entry.url, headers }, credentials };
  }
  return { name, config: { command: entry.command, args: strings(entry.args) }, credentials: names(entry.env) };
}
