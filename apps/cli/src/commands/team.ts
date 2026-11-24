import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { syncOnce, type TeamClient, TeamError, teamApi } from "@grenier/index";
import { embedderLoader } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { deviceName, ensureBaseSpaces, ensurePersonalKey, personalKey } from "../runtime.ts";
import { newTeamToken, saveTeam, teamClient, withTomlValue } from "../team.ts";

/** The Wrangler that `grenier team deploy` runs, pinned like every other dependency. */
const WRANGLER_VERSION = "4.159.0";

export type Wrangler = (args: string[], options?: { cwd?: string }) => Promise<string>;

type Exec = (
  file: string,
  args: string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; maxBuffer: number },
) => Promise<{ stdout: string }>;

export function npxWrangler(env: NodeJS.ProcessEnv, exec: Exec = promisify(execFile)): Wrangler {
  return async (args, options = {}) => {
    try {
      const { stdout } = await exec("npx", ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args], {
        cwd: options.cwd,
        // CI makes Wrangler answer its own prompts instead of waiting for a terminal.
        env: { ...env, CI: "1" },
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
      const said = `${stderr}\n${stdout}`.trim() || (error as Error).message;
      throw new CommandError(`wrangler ${args.slice(0, 2).join(" ")} failed:\n${said}`);
    }
  };
}

export interface TeamDependencies {
  wrangler?: Wrangler;
  /** The built Worker: dist/server beside the CLI's bundle. */
  serverDir?: string;
  fetch?: typeof fetch;
}

function needTeam(io: Io, fetchImpl?: typeof fetch): TeamClient {
  const { paths, config } = environment(io);
  const team = teamClient(config, paths, io.env);
  if (!team) throw new CommandError("no team yet: run grenier team deploy, or open an invite link in the app");
  return fetchImpl ? { ...team, fetch: fetchImpl } : team;
}

async function call<T>(team: TeamClient, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  try {
    return await teamApi<T>(team, path, init);
  } catch (error) {
    if (error instanceof TeamError) throw new CommandError(error.message);
    throw new CommandError(`cannot reach the team store at ${team.url}: ${(error as Error).message}`);
  }
}

/** `grenier team deploy`: the team store into the logged-in Cloudflare account, this machine as its first admin. */
async function deploy(argv: string[], io: Io, dependencies: TeamDependencies): Promise<string[]> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { name: { type: "string", default: "grenier-team" }, member: { type: "string" } },
  });
  if (!/^[a-z0-9-]{1,63}$/.test(values.name)) throw new UsageError("--name takes lowercase letters, digits and -");
  const { paths, config } = environment(io);
  const member = values.member ?? (process.env.USER || "admin").replace(/[^\w.@-]+/g, "-");
  if (!/^[\w.@-]{1,64}$/.test(member)) throw new UsageError("--member takes letters, digits and . _ @ -");
  const serverDir = dependencies.serverDir ?? fileURLToPath(new URL("./server/", import.meta.url));
  const dir = joinPath(paths.home, "team-server");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Run from here, not from the caller's project: npx can take that project's node_modules for Wrangler's.
  const run = dependencies.wrangler ?? npxWrangler(io.env);
  const wrangler = (args: string[]) => run(args, { cwd: dir });

  const whoami = await wrangler(["whoami"]).catch((error: Error) => error.message);
  if (/not authenticated|not logged in/i.test(whoami))
    throw new CommandError("log in to Cloudflare first: npx wrangler login");

  cpSync(joinPath(serverDir, "server.js"), joinPath(dir, "server.js"));
  const { token, hash } = newTeamToken();
  writeFileSync(
    joinPath(dir, "wrangler.json"),
    `${JSON.stringify(
      {
        name: values.name,
        main: "server.js",
        compatibility_date: "2026-11-01",
        durable_objects: { bindings: [{ name: "TEAM", class_name: "TeamStore" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["TeamStore"] }],
        vars: { SETUP_HASH: hash },
      },
      null,
      2,
    )}\n`,
  );
  io.err("Deploying the team store…");
  const deployed = await wrangler(["deploy"]);
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deployed)?.[0];
  if (!url) throw new CommandError(`deployed, but Wrangler printed no workers.dev address:\n${deployed}`);

  const team: TeamClient = { url, token, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) };
  try {
    await teamApi(team, "/api/setup", { body: { member, device: deviceName(config) } });
  } catch (error) {
    if (error instanceof TeamError && error.status === 409) {
      return [
        `The team store is at ${url}, and already has its members.`,
        "Ask an admin for an invite link, then open it in the app.",
      ];
    }
    throw new CommandError(`deployed at ${url}, but setting up the first admin failed: ${(error as Error).message}`);
  }
  saveTeam(paths, url, token);
  await withStore(paths, async (store) => {
    await store.state.set("team_member", member);
    await store.state.set("team_role", "admin");
    await ensureBaseSpaces(store);
  });
  ensurePersonalKey(paths);
  return [
    `The team store is at ${url}, in your own Cloudflare account. This machine is ${deviceName(config)}, and you are its admin, ${member}.`,
    "Invite teammates in the app's Settings.",
  ];
}

export async function team(argv: string[], io: Io, dependencies: TeamDependencies = {}): Promise<string[]> {
  const [action, ...rest] = argv;
  switch (action) {
    case "deploy":
      return deploy(rest, io, dependencies);

    case "rename": {
      const [name] = rest;
      if (!name || !/^[\w.-]{1,40}$/.test(name)) throw new UsageError("team rename takes this machine's new name");
      const { paths, config } = environment(io);
      const client = teamClient(config, paths, io.env);
      if (client)
        await call({ ...client, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) }, "/api/me/device", {
          method: "PUT",
          body: { name },
        });
      const text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
      writeFileSync(paths.config, withTomlValue(text, "machine", "name", name), { mode: 0o600 });
      return [`This machine is ${name} now.`];
    }

    case "spaces": {
      const client = needTeam(io, dependencies.fetch);
      const [sub, name, ...more] = rest;
      if (sub === "add") {
        if (!name) throw new UsageError("team spaces add takes: <name> [--members a,b]");
        const { values } = parseArgs({ args: more, strict: true, options: { members: { type: "string" } } });
        const members = values.members
          ?.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        const made = await call<{ id: string }>(client, "/api/spaces", {
          body: { name, ...(members ? { members } : {}) },
        });
        return [`Made ${made.id}${members ? `, for ${members.join(", ")}` : ", for the whole team"}.`];
      }
      const { spaces } = await call<{ spaces: { id: string; kind: string; members: string[] | null }[] }>(
        client,
        "/api/spaces",
      );
      return spaces.map(
        (space) => `${space.id.padEnd(28)} ${space.kind.padEnd(7)} ${space.members ? space.members.join(", ") : ""}`,
      );
    }

    case "web": {
      const client = needTeam(io, dependencies.fetch);
      const { path } = await call<{ path: string }>(client, "/api/weblinks", { method: "POST" });
      return [
        "Open this link in your browser within 10 minutes; it signs that browser in once:",
        `${client.url}${path}`,
      ];
    }

    case "webhook": {
      const [routine] = rest;
      if (!routine) throw new UsageError("team webhook takes a routine's id");
      const client = needTeam(io, dependencies.fetch);
      const { path } = await call<{ path: string }>(client, "/api/webhooks", { body: { routine } });
      return [
        "Point the other tool's webhook at this address; each call becomes a request for the routine. Keep it secret:",
        `${client.url}${path}`,
      ];
    }

    case "sync": {
      const { paths, config } = environment(io);
      const client = needTeam(io, dependencies.fetch);
      const result = await withStore(paths, async (store) => {
        try {
          if (!(await store.state.get("team_me_space"))) {
            const me = await teamApi<{ me: string }>(client, "/api/me");
            await store.state.set("team_me_space", me.me);
          }
          return await syncOnce({
            store,
            embedder: await embedderLoader(config, paths, io.err)(),
            team: client,
            personalKey: personalKey(paths),
          });
        } catch (error) {
          if (error instanceof TeamError) throw new CommandError(error.message);
          throw error;
        }
      });
      return [
        `Sent ${result.pushed} change(s), took ${result.pulled}.`,
        ...result.refused.map((refused) => `Refused ${refused.recordId}: ${refused.reason}`),
        ...(result.unopened > 0
          ? [
              `${result.unopened} of your \`me\` records do not open here: grenier key set <the key from your other machine>`,
            ]
          : []),
      ];
    }

    default:
      throw new UsageError("team takes: deploy, rename, spaces, web, webhook or sync");
  }
}
