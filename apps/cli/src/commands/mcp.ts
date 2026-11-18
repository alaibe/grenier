import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createMcpServer } from "@grenier/gateway";
import { addClient, readerFor, SCOPE_KINDS } from "@grenier/index";
import { openSqliteStore } from "@grenier/store/sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../../package.json";
import { embedderLoader, gitFiles, repoResolver } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

/** `grenier mcp serve`: the MCP server over stdio, for an agent that launches it in its working directory. */
export async function serve(io: Io): Promise<number> {
  const { paths, config } = environment(io);
  const store = openSqliteStore(paths.db);
  const server = createMcpServer({
    store,
    files: gitFiles,
    embedder: embedderLoader(config, paths, io.err),
    resolveRepo: repoResolver(io.cwd),
    // The client token `grenier mcp install` wrote into the app's config, looked up at each call.
    reader: () => readerFor(store, io.env.GRENIER_CLIENT_TOKEN),
    version,
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.stdin.once("end", resolve);
  });
  await server.connect(transport);
  await closed;
  await server.close();
  await store.close();
  return 0;
}

export const CLIENTS = ["claude-code", "cursor", "codex", "claude-desktop"] as const;
export type McpClient = (typeof CLIENTS)[number];

/** Where each client keeps its MCP servers, for this user. */
export function configPath(client: McpClient, home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  switch (client) {
    case "claude-code":
      return join(home, ".claude.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "codex":
      return join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
    case "claude-desktop":
      if (platform === "darwin")
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32")
        return join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.grenier-tmp`, text, { mode: 0o600 });
  renameSync(`${path}.grenier-tmp`, path);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Replaces or appends the `[mcp_servers.grenier]` table, leaving the rest of the file as it was. */
export function withCodexServer(text: string, command: string, args: string[], env: Record<string, string>): string {
  const lines = [
    "[mcp_servers.grenier]",
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    ...(Object.keys(env).length > 0
      ? [
          `env = { ${Object.entries(env)
            .map(([key, value]) => `${key} = ${tomlString(value)}`)
            .join(", ")} }`,
        ]
      : []),
  ];
  const all = text.split("\n");
  const start = all.findIndex((line) => line.trim() === "[mcp_servers.grenier]");
  if (start === -1) {
    const body = text.replace(/\n*$/, "");
    return `${body}${body ? "\n\n" : ""}${lines.join("\n")}\n`;
  }
  let end = start + 1;
  while (end < all.length && !/^\s*\[/.test(all[end] ?? "")) end++;
  while (end > start + 1 && (all[end - 1] ?? "").trim() === "") end--;
  return [...all.slice(0, start), ...lines, ...all.slice(end)].join("\n");
}

/** Sets `mcpServers.grenier` in a client's JSON config, keeping every other key. */
export function withJsonServer(
  text: string,
  server: { command: string; args: string[]; env?: Record<string, string> },
  extra: Record<string, unknown> = {},
): string {
  let config: Record<string, unknown> = {};
  if (text.trim() !== "") {
    try {
      config = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new CommandError("the client's config file is not valid JSON; fix it or move it aside first");
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.grenier = { ...extra, ...server };
  config.mcpServers = servers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** A word for a POSIX shell, quoted unless it is plain. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

const isPromptHook = (command: unknown) =>
  typeof command === "string" && command.includes("grenier") && command.endsWith(" hook prompt");

/**
 * Adds Grenier's UserPromptSubmit hook to Claude Code's settings, in place of one added before, keeping every other
 * key and hook.
 */
export function withPromptHook(text: string, command: string): string {
  let settings: Record<string, unknown> = {};
  if (text.trim() !== "") {
    try {
      settings = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new CommandError("Claude Code's settings.json is not valid JSON; fix it or move it aside first");
    }
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks.UserPromptSubmit) ? (hooks.UserPromptSubmit as unknown[]) : [];
  const ours = (group: unknown) =>
    Array.isArray((group as { hooks?: unknown })?.hooks) &&
    ((group as { hooks: { command?: unknown }[] }).hooks ?? []).some((hook) => isPromptHook(hook?.command));
  hooks.UserPromptSubmit = [
    ...groups.filter((group) => !ours(group)),
    { hooks: [{ type: "command", command, timeout: 10 }] },
  ];
  settings.hooks = hooks;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * `grenier mcp install <client> [--scope …] [--hook]`: adds Grenier's MCP server (over stdio) to that client's
 * config, with a client token of its own whose scope says which personal data it may read (none by default).
 * Installing again revokes the previous token. `--hook`, for Claude Code only, also adds the prompt hook.
 */
export async function install(
  argv: string[],
  io: Io,
  where: { home?: string; platform?: NodeJS.Platform } = {},
): Promise<string> {
  const [client, ...rest] = argv;
  if (!CLIENTS.includes(client as McpClient)) throw new UsageError(`mcp install takes one of: ${CLIENTS.join(", ")}`);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: { scope: { type: "string", default: "" }, hook: { type: "boolean", default: false } },
  });
  if (values.hook && client !== "claude-code") throw new UsageError("--hook is for claude-code only");
  const scopes = values.scope
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const { paths } = environment(io);
  const token = await withStore(paths, async (store) => {
    const known = new Set([...SCOPE_KINDS, ...(await store.sources.list()).map((source) => source.name)]);
    const unknown = scopes.filter((scope) => !known.has(scope));
    if (unknown.length > 0) throw new CommandError(`unknown scope ${unknown.join(", ")}: use ${[...known].join(", ")}`);
    await store.clients.revoke(client as string, Date.now());
    return addClient(store, client as string, scopes);
  });
  const path = configPath(client as McpClient, where.home ?? homedir(), where.platform ?? process.platform, io.env);
  const [command = process.execPath, ...prefix] = io.self;
  const args = [...prefix, "mcp", "serve"];
  const env: Record<string, string> = { GRENIER_CLIENT_TOKEN: token };
  for (const name of ["GRENIER_HOME", "GRENIER_CONFIG", "GRENIER_DB"]) {
    const value = io.env[name];
    if (value) env[name] = value;
  }
  const server = { command, args, env };
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";

  writeAtomically(
    path,
    client === "codex"
      ? withCodexServer(text, command, args, env)
      : withJsonServer(text, server, client === "claude-code" ? { type: "stdio" } : {}),
  );
  const reads =
    scopes.length > 0
      ? `may read ${scopes.join(", ")}`
      : "reads no personal data; install again with --scope notes,calendar (or mail, memory, a source's name) to change that";
  const added = `Added Grenier's MCP server to ${path}, with a client token of its own that ${reads}.`;
  if (!values.hook) return `${added} Restart ${client} to load it.`;

  const settings = join(where.home ?? homedir(), ".claude", "settings.json");
  const variables = ["GRENIER_HOME", "GRENIER_CONFIG", "GRENIER_DB"].flatMap((name) =>
    io.env[name] ? [`${name}=${shellWord(io.env[name] as string)}`] : [],
  );
  const hook = [...variables, ...[command, ...prefix].map(shellWord), "hook", "prompt"].join(" ");
  writeAtomically(settings, withPromptHook(existsSync(settings) ? readFileSync(settings, "utf8") : "", hook));
  return `${added} Added the prompt hook to ${settings}: a recorded answer close to a prompt reaches the agent with it. Restart ${client} to load both.`;
}
