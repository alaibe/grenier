import type { ServerEntry } from "./types.ts";

/** Codex's own keys of a server's table that Grenier does not read, kept as they were written. */
const RAW = "__toml";

const bare = /^[A-Za-z0-9_-]+$/;
const key = (name: string) => (bare.test(name) ? name : JSON.stringify(name));
const str = (value: unknown) => JSON.stringify(String(value));

/** A TOML string, array of strings or inline table of strings, as JSON-ish values; anything else stays raw. */
function value(raw: string): unknown {
  const text = raw.trim();
  if (text.startsWith("{")) {
    const out: Record<string, string> = {};
    for (const match of text.matchAll(/("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
      out[String(value(match[1] as string))] = String(value(match[2] as string));
    }
    return out;
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One table's name, as `[mcp_servers.<name>]` or `[mcp_servers.<name>.env]`. */
const TABLE = /^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|([^\].]+))(\.env)?\]\s*$/;

/** The `[mcp_servers.<name>]` tables of a Codex config.toml, in Claude Code's shape: command, args, env, url, headers. */
export function readServers(text: string): Record<string, ServerEntry> {
  const out: Record<string, ServerEntry> = {};
  let current: ServerEntry | null = null;
  let inEnv = false;
  const lines = text.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] as string;
    const table = TABLE.exec(line);
    if (table) {
      const name = table[1] !== undefined ? (JSON.parse(`"${table[1]}"`) as string) : (table[2] as string);
      out[name] ??= {};
      current = out[name] as ServerEntry;
      inEnv = Boolean(table[3]);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const pair = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (!current || !pair) continue;
    let raw = pair[2] as string;
    // An array may run over several lines.
    while (raw.trim().startsWith("[") && (raw.match(/\[/g)?.length ?? 0) > (raw.match(/\]/g)?.length ?? 0)) {
      at++;
      if (at >= lines.length) break;
      raw += `\n${lines[at]}`;
    }
    const name = pair[1] as string;
    if (inEnv) {
      current.env = { ...((current.env as Record<string, string>) ?? {}), [name]: String(value(raw)) };
    } else if (name === "command" || name === "url") current[name] = value(raw);
    else if (name === "args") current.args = value(raw);
    else if (name === "env") current.env = value(raw);
    else if (name === "http_headers") current.headers = value(raw);
    else current[RAW] = { ...((current[RAW] as Record<string, string>) ?? {}), [name]: raw.trim() };
  }
  return out;
}

function table(name: string, entry: ServerEntry): string {
  const lines = [`[mcp_servers.${key(name)}]`];
  const pairs = (value: unknown) =>
    `{ ${Object.entries((value ?? {}) as Record<string, unknown>)
      .map(([k, v]) => `${key(k)} = ${str(v)}`)
      .join(", ")} }`;
  if (typeof entry.url === "string") {
    lines.push(`url = ${str(entry.url)}`);
    if (entry.headers && Object.keys(entry.headers).length > 0) lines.push(`http_headers = ${pairs(entry.headers)}`);
  } else {
    lines.push(`command = ${str(entry.command ?? "")}`);
    if (Array.isArray(entry.args)) lines.push(`args = [${entry.args.map(str).join(", ")}]`);
    if (entry.env && Object.keys(entry.env).length > 0) lines.push(`env = ${pairs(entry.env)}`);
  }
  for (const [k, raw] of Object.entries((entry[RAW] ?? {}) as Record<string, string>)) lines.push(`${k} = ${raw}`);
  return lines.join("\n");
}

/** The config with its MCP servers replaced by these, every other line kept where it was. */
export function writeServers(text: string, servers: Record<string, ServerEntry>): string {
  const kept: string[] = [];
  let inServers = false;
  for (const line of text.split("\n")) {
    if (TABLE.test(line)) {
      inServers = true;
      continue;
    }
    if (/^\s*\[/.test(line)) inServers = false;
    if (!inServers) kept.push(line);
  }
  const body = kept.join("\n").replace(/\n*$/, "");
  const tables = Object.entries(servers).map(([name, entry]) => table(name, entry));
  return tables.length === 0 ? `${body}\n` : `${body}${body ? "\n\n" : ""}${tables.join("\n\n")}\n`;
}
