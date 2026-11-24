import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { createMcpServer } from "@grenier/gateway";
import { addClient, readerFor, resolveScopes } from "@grenier/index";
import { openSqliteStore } from "@grenier/store/sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../../package.json";
import { embedderLoader, gitFiles, repoResolver } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore, writeAtomically } from "../io.ts";
import { ensureBaseTops, identity } from "../runtime.ts";

/** `grenier mcp serve`: the MCP server over stdio, for an agent that launches it in its working directory. */
export async function serve(io: Io): Promise<number> {
  const { paths, config } = environment(io);
  const store = openSqliteStore(paths.db);
  await ensureBaseTops(store);
  const server = createMcpServer({
    store,
    files: gitFiles,
    embedder: embedderLoader(config, paths, io.err),
    resolveRepo: repoResolver(io.cwd),
    // The client token `grenier mcp install` wrote into the app's config, looked up at each call.
    reader: () => readerFor(store, io.env.GRENIER_CLIENT_TOKEN),
    me: () => identity(store, config),
    version,
    ...(io.env.GRENIER_SESSION ? { sessionId: io.env.GRENIER_SESSION } : {}),
    ...(io.env.GRENIER_RUN_TOP ? { runTop: io.env.GRENIER_RUN_TOP } : {}),
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

/** The same program at a PATH entry that survives upgrades, in place of a versioned path such as Homebrew's Cellar. */
export function stableProgram(program: string, searchPath: string | undefined): string {
  let real: string;
  try {
    real = realpathSync(program);
  } catch {
    return program;
  }
  for (const dir of (searchPath ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, basename(program));
    if (candidate === program || /[\\/]Cellar[\\/]|[\\/]versions[\\/]/.test(candidate)) continue;
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // Not there: try the next folder.
    }
  }
  return program;
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

export const isPromptHook = (command: unknown): command is string =>
  typeof command === "string" && command.includes("grenier") && command.endsWith(" hook prompt");

/** Adds Grenier's UserPromptSubmit hook to Claude Code's settings in place of an earlier one, keeping the rest. */
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

/** `grenier mcp install <client>`: installing again revokes the client's previous token. */
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
    options: { scope: { type: "string", default: "*" }, hook: { type: "boolean", default: false } },
  });
  if (values.hook && client !== "claude-code") throw new UsageError("--hook is for claude-code only");
  const scopes = values.scope
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const { paths } = environment(io);
  const path = configPath(client as McpClient, where.home ?? homedir(), where.platform ?? process.platform, io.env);
  const [self = process.execPath, ...prefix] = io.self;
  const command = stableProgram(self, io.env.PATH);
  const args = [...prefix, "mcp", "serve"];
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const settings = join(where.home ?? homedir(), ".claude", "settings.json");
  const settingsText = values.hook && existsSync(settings) ? readFileSync(settings, "utf8") : "";
  const configFor = (token: string) => {
    const env: Record<string, string> = { GRENIER_CLIENT_TOKEN: token };
    for (const name of ["GRENIER_HOME", "GRENIER_CONFIG", "GRENIER_DB"]) {
      const value = io.env[name];
      if (value) env[name] = value;
    }
    return client === "codex"
      ? withCodexServer(text, command, args, env)
      : withJsonServer(text, { command, args, env }, client === "claude-code" ? { type: "stdio" } : {});
  };
  const variables = ["GRENIER_HOME", "GRENIER_CONFIG", "GRENIER_DB"].flatMap((name) =>
    io.env[name] ? [`${name}=${shellWord(io.env[name] as string)}`] : [],
  );
  const hook = [...variables, ...[command, ...prefix].map(shellWord), "hook", "prompt"].join(" ");
  // Both files must be editable before the old token is revoked, so a failure leaves the client working.
  configFor("gc_check");
  const hooked = values.hook ? withPromptHook(settingsText, hook) : null;

  const token = await withStore(paths, async (store) => {
    await ensureBaseTops(store);
    // Checked before the old token goes, so a mistyped scope leaves the client working.
    await resolveScopes(store, scopes).catch((error: Error) => {
      throw new CommandError(error.message);
    });
    await store.clients.revoke(client as string, Date.now());
    return addClient(store, client as string, scopes);
  });
  writeAtomically(path, configFor(token));
  const reads = scopes.includes("*")
    ? "may read every top folder; install again with --scope <folders> to narrow it"
    : scopes.length > 0
      ? `may read ${scopes.join(", ")}`
      : "reads the repositories' folders only";
  const added = `Added Grenier's MCP server to ${path}, with a client token of its own that ${reads}.`;
  if (!values.hook) return `${added} Restart ${client} to load it.`;

  writeAtomically(settings, hooked as string);
  return `${added} Added the prompt hook to ${settings}: a recorded answer close to a prompt reaches the agent with it. Restart ${client} to load both.`;
}
