import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { open, seal, VaultError } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { addClient, rekeyed, resolveScopes, unopenedCount } from "@grenier/index";
import type { Store } from "@grenier/store";
import type { Route } from "./host.ts";
import { CommandError, writeAtomically } from "./io.ts";
import { ensureBaseTops, ensurePersonalKey, personalKey, personalKeyFile } from "./runtime.ts";

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

const LABELS: Record<McpClient, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
};

export interface Where {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** How this Grenier runs, so the app it is added to starts the same one. */
  self: string[];
}

/** Whether an app's config starts Grenier's MCP server. */
function connected(app: McpClient, path: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  if (app === "codex") return /^\[mcp_servers\.grenier\]/m.test(text);
  try {
    return Boolean((JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers?.grenier);
  } catch {
    return false;
  }
}

/** Adds Grenier's MCP server to an app on this computer, with a token of its own; adding it again replaces the token. */
export async function connectApp(store: Store, app: McpClient, scopes: string[], where: Where): Promise<string> {
  const path = configPath(app, where.home, where.platform, where.env);
  const [self = process.execPath, ...prefix] = where.self;
  const command = stableProgram(self, where.env.PATH);
  const args = [...prefix, "mcp", "serve"];
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const configFor = (token: string) => {
    const env: Record<string, string> = { GRENIER_CLIENT_TOKEN: token };
    for (const name of ["GRENIER_HOME", "GRENIER_CONFIG", "GRENIER_DB"]) {
      const value = where.env[name];
      if (value) env[name] = value;
    }
    return app === "codex"
      ? withCodexServer(text, command, args, env)
      : withJsonServer(text, { command, args, env }, app === "claude-code" ? { type: "stdio" } : {});
  };
  // The config must be editable, and the folders known, before the old token goes: a failure leaves the app working.
  configFor("gc_check");
  await ensureBaseTops(store);
  await resolveScopes(store, scopes).catch((error: Error) => {
    throw new CommandError(error.message);
  });
  await store.clients.revoke(app, Date.now());
  writeAtomically(path, configFor(await addClient(store, app, scopes)));
  return path;
}

/** The apps on this computer Grenier can be added to, and the personal key; `resync` runs a step between sync rounds. */
export function machineRoutes(
  store: Store,
  paths: GrenierPaths,
  where: Where,
  resync: (between: () => Promise<void>) => Promise<unknown>,
): Route {
  const ok = (body: unknown) => ({ status: 200, body });
  const no = (status: number, error: string) => ({ status, body: { error } });
  return async (method, path, body) => {
    if (path === "/apps" && method === "GET") {
      return ok({
        apps: CLIENTS.map((app) => ({
          app,
          label: LABELS[app],
          connected: connected(app, configPath(app, where.home, where.platform, where.env)),
        })),
      });
    }
    const app = /^\/apps\/([\w-]+)$/.exec(path)?.[1];
    if (app && method === "POST") {
      if (!CLIENTS.includes(app as McpClient)) return no(404, `Grenier cannot be added to ${app}`);
      const given = (body as { scopes?: unknown } | undefined)?.scopes;
      const scopes = Array.isArray(given) ? given.map(String) : ["*"];
      try {
        const file = await connectApp(store, app as McpClient, scopes, where);
        return ok({ app, file, restart: LABELS[app as McpClient] });
      } catch (error) {
        return no(409, (error as Error).message);
      }
    }
    // The key is shown only when asked for, and never written anywhere but its own file.
    if (path === "/key" && method === "GET") return ok({ unopened: await unopenedCount(store) });
    if (path === "/key" && method === "POST") return ok({ key: ensurePersonalKey(paths) });
    if (path === "/key" && method === "PUT") {
      const key = String((body as { key?: unknown } | undefined)?.key ?? "").trim();
      try {
        await open(key, "check", await seal(key, "check", new Uint8Array([1])));
      } catch (error) {
        return no(400, error instanceof VaultError ? error.message : "that is not a personal key");
      }
      if (personalKey(paths) !== key) {
        await resync(async () => {
          writeFileSync(personalKeyFile(paths), `${key}\n`, { mode: 0o600 });
          await rekeyed(store);
        });
      }
      return ok({ saved: true, unopened: await unopenedCount(store) });
    }
    return null;
  };
}
