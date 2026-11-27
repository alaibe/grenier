import { parse, stringify } from "smol-toml";
import type { ServerEntry } from "./types.ts";

/** Codex's own keys of a server's table that Grenier does not read, kept as they were. */
const OWN = "__codex";

/** Codex's name of each key Claude Code's shape names otherwise. */
const CODEX_NAMES: Record<string, string> = { headers: "http_headers" };
const SHAPE_NAMES: Record<string, string> = { http_headers: "headers" };
const SHAPE = new Set(["command", "args", "env", "url", "http_headers"]);

/** A table of Codex's servers, `[mcp_servers.<name>]` or one inside it, as `[mcp_servers.<name>.env]`. */
const SERVERS_TABLE = /^\s*\[\[?\s*(?:mcp_servers|"mcp_servers")\s*[.\]]/;

/** The `[mcp_servers.<name>]` tables of a Codex config.toml, in Claude Code's shape: command, args, env, url, headers. */
export function readServers(text: string): Record<string, ServerEntry> {
  const servers = (parse(text).mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, ServerEntry> = {};
  for (const [name, table] of Object.entries(servers)) {
    const entry: ServerEntry = {};
    const own: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(table)) {
      if (SHAPE.has(key)) entry[SHAPE_NAMES[key] ?? key] = value;
      else own[key] = value;
    }
    if (Object.keys(own).length > 0) entry[OWN] = own;
    out[name] = entry;
  }
  return out;
}

/** The config with its MCP servers replaced by these, every other line kept where it was. */
export function writeServers(text: string, servers: Record<string, ServerEntry>): string {
  const kept: string[] = [];
  let inServers = false;
  for (const line of text.split("\n")) {
    if (SERVERS_TABLE.test(line)) inServers = true;
    else if (/^\s*\[/.test(line)) inServers = false;
    if (!inServers) kept.push(line);
  }
  const tables: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(servers)) {
    const { [OWN]: own, ...shape } = entry;
    const table: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) {
      const codex = CODEX_NAMES[key] ?? key;
      const empty = typeof value === "object" && value !== null && Object.keys(value).length === 0 && key !== "args";
      if (SHAPE.has(codex) && value !== undefined && !empty) table[codex] = value;
    }
    tables[name] = { ...table, ...(own as Record<string, unknown> | undefined) };
  }
  const body = kept.join("\n").replace(/\n*$/, "");
  if (Object.keys(tables).length === 0) return `${body}\n`;
  return `${body}${body ? "\n\n" : ""}${stringify({ mcp_servers: tables }).trim()}\n`;
}
