import { realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { addClient, resolveScopes } from "@grenier/index";
import type { Store } from "@grenier/store";
import { isAgent, type McpClient, type Where } from "./agents/index.ts";
import { Refusal } from "./io.ts";
import { SETUP_SKILL } from "./setup-skill.ts";
import { writeSkill } from "./skill-files.ts";

/** The same program at a PATH entry that survives upgrades, in place of a versioned path such as Homebrew's Cellar. */
function stableProgram(program: string, searchPath: string | undefined): string {
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

/** Whether an app's config starts Grenier's MCP server. */
export function connected(client: McpClient, where: Where): boolean {
  try {
    return Boolean(client.servers(where).grenier);
  } catch {
    return false;
  }
}

/**
 * Adds Grenier's MCP server to an app on this computer, with a token of its own; adding it again replaces the token.
 * An agent also gets the skill that sets up the knowledge base, Grenier's own, written again each time.
 */
export async function connectApp(store: Store, client: McpClient, scopes: string[], where: Where): Promise<string> {
  const [self = process.execPath, ...prefix] = where.self;
  const command = stableProgram(self, where.env.PATH);
  const homes: Record<string, string> = {};
  for (const name of ["GRENIER_HOME", "GRENIER_CONFIG", "GRENIER_DB"]) {
    const value = where.env[name];
    if (value) homes[name] = value;
  }
  const entryFor = (token: string) => ({
    command,
    args: [...prefix, "mcp", "serve"],
    env: { GRENIER_CLIENT_TOKEN: token, ...homes },
  });
  // The config must be readable, and the folders known, before the old token goes: a failure leaves the app working.
  client.servers(where);
  try {
    resolveScopes(scopes);
  } catch (error) {
    throw new Refusal((error as Error).message);
  }
  await store.clients.revoke(client.id, Date.now());
  const token = await addClient(store, client.id, scopes);
  client.editServers(where, (servers) => {
    servers.grenier = entryFor(token);
  });
  if (isAgent(client)) {
    writeSkill(join(client.skillsDir(where), "grenier-setup"), { "SKILL.md": SETUP_SKILL });
    // Agents skip a call to a deferred tool, but not the context a hook gives them.
    client.startHook?.(where, [command, ...prefix], homes);
  }
  return client.configPath(where);
}
