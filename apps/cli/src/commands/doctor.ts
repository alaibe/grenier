import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandWords } from "@grenier/connectors";
import { ConfigError } from "@grenier/core";
import { readerFor, teamApi } from "@grenier/index";
import { DEFAULT_MODEL, modelDir } from "@grenier/index/node";
import { loadPrices, priceOf } from "@grenier/log";
import { version } from "../../package.json";
import { daemonState } from "../daemon.ts";
import { environment, type Io, withStore } from "../io.ts";
import { teamClient } from "../team.ts";
import { CLIENTS, configPath, isPromptHook, type McpClient } from "./mcp.ts";

type Level = "ok" | "warn" | "fail" | "info";
interface Check {
  level: Level;
  text: string;
}

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Grenier's entry in a client's config: the program it launches and the token it passes, when there is one. */
function serverEntry(client: McpClient, text: string): { command: string; token: string | undefined } | null {
  if (client === "codex") {
    const table = /^\[mcp_servers\.grenier\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text)?.[1];
    const command = table && /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(table)?.[1];
    if (!command) return null;
    const token = /GRENIER_CLIENT_TOKEN\s*=\s*"([^"]+)"/.exec(table ?? "")?.[1];
    return { command: JSON.parse(`"${command}"`) as string, token };
  }
  try {
    const server = (JSON.parse(text) as { mcpServers?: Record<string, { command?: unknown; env?: unknown }> })
      .mcpServers?.grenier;
    if (!server || typeof server.command !== "string") return null;
    const env = (server.env ?? {}) as Record<string, unknown>;
    const token = typeof env.GRENIER_CLIENT_TOKEN === "string" ? env.GRENIER_CLIENT_TOKEN : undefined;
    return { command: server.command, token };
  } catch {
    return null;
  }
}

/** The program a hook command runs: its first word after any VAR=value. */
function hookProgram(command: string): string | null {
  try {
    return commandWords(command).find((word) => !/^[A-Z_]+=/.test(word)) ?? null;
  } catch {
    return null;
  }
}

/**
 * `grenier doctor`: checks what makes Grenier work end to end, and says what to do about each problem. Exits 1 when
 * something is broken (a fail), 0 otherwise.
 */
export async function doctor(
  io: Io,
  where: { home?: string; platform?: NodeJS.Platform } = {},
): Promise<{ lines: string[]; code: number }> {
  const checks: Check[] = [];
  const add = (level: Level, text: string) => checks.push({ level, text });
  const finish = () => ({
    lines: checks.map((check) => `${check.level.padEnd(6)}${check.text}`),
    code: checks.some((check) => check.level === "fail") ? 1 : 0,
  });

  let env: ReturnType<typeof environment>;
  try {
    env = environment(io);
  } catch (error) {
    if (error instanceof ConfigError) {
      add("fail", `config: ${error.message}`);
      return finish();
    }
    throw error;
  }
  const { paths, config } = env;
  add("ok", `config ${paths.config}${env.configFound ? "" : " (none, using defaults)"}`);

  const prices = loadPrices(config.prices);
  const facts = await withStore(paths, async (store) => ({
    schema: await store.schemaVersion(),
    models: (await store.usage.list({ since: Date.now() - 30 * 86_400_000 })).map((row) => row.model),
  }));
  add("ok", `database ${paths.db} (schema ${facts.schema})`);

  const daemon = await daemonState(paths.home);
  if (daemon.state === "running") {
    if (daemon.version !== version) {
      add("warn", `daemon runs ${daemon.version}, this command is ${version}: grenier stop && grenier start`);
    } else {
      add("ok", `daemon ${daemon.version} running (pid ${daemon.pid}, port ${daemon.port})`);
    }
  } else {
    if (daemon.state === "stale") {
      add("warn", `daemon record names pid ${daemon.pid}, now another program's: grenier stop removes it`);
    }
    if (await portAnswers(config.proxy.port)) {
      add("fail", `127.0.0.1:${config.proxy.port} is taken by another program: set [proxy] port in ${paths.config}`);
    } else {
      add("warn", "daemon is not running: grenier start (grenier run starts it too)");
    }
  }

  const home = where.home ?? homedir();
  const platform = where.platform ?? process.platform;
  let installed = 0;
  for (const client of CLIENTS) {
    const path = configPath(client, home, platform, io.env);
    if (!existsSync(path)) continue;
    const entry = serverEntry(client, readFileSync(path, "utf8"));
    if (!entry) continue;
    installed += 1;
    const fix = `grenier mcp install ${client}`;
    if (!runnable(entry.command)) {
      add("fail", `${client}: launches ${entry.command}, which is gone: ${fix}`);
      continue;
    }
    const reader = await withStore(paths, (store) => readerFor(store, entry.token));
    if (!reader) add("fail", `${client}: its client token is revoked or unknown here: ${fix}`);
    else add("ok", `${client}: MCP server installed (${path})`);
  }
  if (installed === 0) add("warn", "no AI tool has Grenier's MCP server: grenier mcp install claude-code");

  const settings = join(home, ".claude", "settings.json");
  if (existsSync(settings)) {
    try {
      const parsed = JSON.parse(readFileSync(settings, "utf8")) as {
        hooks?: { UserPromptSubmit?: { hooks?: { command?: unknown }[] }[] };
      };
      const command = (parsed.hooks?.UserPromptSubmit ?? [])
        .flatMap((group) => group.hooks ?? [])
        .map((hook) => hook.command)
        .find((value): value is string => isPromptHook(value));
      const program = command ? hookProgram(command) : null;
      if (command && program && !runnable(program)) {
        add("fail", `Claude Code's prompt hook runs ${program}, which is gone: grenier mcp install claude-code --hook`);
      } else if (command) {
        add("ok", "Claude Code's prompt hook is installed");
      } else {
        add("info", "Claude Code's prompt hook is not installed (optional): grenier mcp install claude-code --hook");
      }
    } catch {
      add("warn", `${settings} is not valid JSON`);
    }
  }

  const team = teamClient(config, paths, io.env);
  if (config.team.url && !team) {
    add(
      "fail",
      `team store ${config.team.url} is set but this machine has no token: join from an invite link, grenier team join <link>`,
    );
  } else if (team) {
    try {
      const me = await Promise.race([
        teamApi<{ name?: string }>(team, "/api/me"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 5 s")), 5000)),
      ]);
      add("ok", `team store ${config.team.url} knows this machine as ${me.name ?? "a member"}`);
    } catch (error) {
      add("fail", `team store ${config.team.url}: ${(error as Error).message}`);
    }
  }

  if (config.store.embeddings === "off") {
    add("info", "embeddings are off: recall matches questions by their words only");
  } else if (
    !Object.keys(DEFAULT_MODEL.files).every((file) => existsSync(join(modelDir(join(paths.home, "models")), file)))
  ) {
    add("info", "the embedding model is not downloaded yet: it downloads on first use");
  } else {
    add("ok", "the embedding model is downloaded");
  }

  const unpriced = [...new Set(facts.models)].filter(
    (model): model is string => model !== null && priceOf(model, prices) === null,
  );
  if (unpriced.length > 0) {
    add(
      "warn",
      `no price for ${unpriced.join(", ")}: their requests count as $0 (add them under [prices."<model>"] in ${paths.config})`,
    );
  }
  return finish();
}
