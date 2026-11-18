import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { repoId, repoRoot } from "@grenier/connectors/git";
import { syncOnce, type TeamBudget, type TeamClient, TeamError, teamApi } from "@grenier/index";
import { cacheSavingsOf, loadPrices } from "@grenier/log";
import { embedderLoader } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { newTeamToken, saveTeam, teamClient } from "../team.ts";

/** The Wrangler that `grenier team deploy` runs, pinned like every other dependency. */
export const WRANGLER_VERSION = "4.159.0";

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
        // CI makes Wrangler answer its own prompts (applying migrations) instead of waiting for a terminal.
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
  /** The built Worker and its migrations: dist/server beside the CLI's bundle. */
  serverDir?: string;
  fetch?: typeof fetch;
}

function needTeam(io: Io, fetchImpl?: typeof fetch): TeamClient {
  const { paths, config } = environment(io);
  const team = teamClient(config, paths, io.env);
  if (!team) throw new CommandError("no team yet: run grenier team join <url> <token>, or grenier team deploy");
  return fetchImpl ? { ...team, fetch: fetchImpl } : team;
}

async function call<T>(team: TeamClient, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  try {
    return await teamApi<T>(team, path, init);
  } catch (error) {
    if (error instanceof TeamError) throw new CommandError(error.message);
    throw new CommandError(`cannot reach the team server at ${team.url}: ${(error as Error).message}`);
  }
}

async function repoFor(io: Io, path: string | undefined): Promise<{ root: string; id: string }> {
  const dir = resolve(io.cwd, path ?? ".");
  const root = await repoRoot(dir);
  const id = root ? await repoId(root) : null;
  if (!root || !id) throw new CommandError(`not a git repository with a commit: ${dir}`);
  return { root, id };
}

const SQL_NAME = /^[\w.@-]{1,64}$/;

/** `grenier team deploy`: the team server into the logged-in Cloudflare account, then this machine joined as admin. */
async function deploy(argv: string[], io: Io, dependencies: TeamDependencies): Promise<string[]> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { name: { type: "string", default: "grenier-team" }, admin: { type: "string", default: "admin" } },
  });
  if (!/^[a-z0-9-]{1,63}$/.test(values.name)) throw new UsageError("--name takes lowercase letters, digits and -");
  if (!SQL_NAME.test(values.admin)) throw new UsageError("--admin takes letters, digits and . _ @ -");
  const serverDir = dependencies.serverDir ?? fileURLToPath(new URL("./server/", import.meta.url));
  const { paths } = environment(io);
  const out = (line: string) => io.err(line);
  const dir = join(paths.home, "team-server");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Run from here, not from the caller's project: npx can take that project's node_modules for Wrangler's.
  const run = dependencies.wrangler ?? npxWrangler(io.env);
  const wrangler = (args: string[]) => run(args, { cwd: dir });

  const whoami = await wrangler(["whoami"]).catch((error: Error) => error.message);
  if (/not authenticated|not logged in/i.test(whoami))
    throw new CommandError("log in to Cloudflare first: npx wrangler login");

  cpSync(join(serverDir, "server.js"), join(dir, "server.js"));
  cpSync(join(serverDir, "migrations"), join(dir, "migrations"), { recursive: true });

  const findDatabase = async () =>
    (JSON.parse(await wrangler(["d1", "list", "--json"])) as { name: string; uuid: string }[]).find(
      (database) => database.name === values.name,
    )?.uuid;
  let databaseId = await findDatabase();
  if (!databaseId) {
    out(`Creating the D1 database ${values.name}…`);
    await wrangler(["d1", "create", values.name]);
    databaseId = await findDatabase();
  }
  if (!databaseId) throw new CommandError(`could not find or create the D1 database ${values.name}`);

  const bucket = `${values.name}-vault`;
  const buckets = await wrangler(["r2", "bucket", "list"]).catch((error: Error) => {
    if (/code: 10042/.test(error.message))
      throw new CommandError(
        "turn on R2 in the Cloudflare dashboard first (its free tier is enough), then run grenier team deploy again",
      );
    throw error;
  });
  if (!buckets.includes(bucket)) {
    out(`Creating the R2 bucket ${bucket}…`);
    await wrangler(["r2", "bucket", "create", bucket]);
  }

  writeFileSync(
    join(dir, "wrangler.json"),
    `${JSON.stringify(
      {
        name: values.name,
        main: "server.js",
        compatibility_date: "2026-11-01",
        d1_databases: [
          { binding: "DB", database_name: values.name, database_id: databaseId, migrations_dir: "migrations" },
        ],
        durable_objects: { bindings: [{ name: "TEAM", class_name: "TeamCounter" }] },
        r2_buckets: [{ binding: "VAULT", bucket_name: bucket }],
        migrations: [{ tag: "v1", new_sqlite_classes: ["TeamCounter"] }],
      },
      null,
      2,
    )}\n`,
  );

  out("Applying the database migrations…");
  await wrangler(["d1", "migrations", "apply", values.name, "--remote"]);
  out("Deploying the Worker…");
  const deployed = await wrangler(["deploy"]);
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deployed)?.[0];
  if (!url) throw new CommandError(`deployed, but Wrangler printed no workers.dev address:\n${deployed}`);

  const admins = JSON.parse(
    await wrangler([
      "d1",
      "execute",
      values.name,
      "--remote",
      "--json",
      "--command",
      "SELECT count(*) AS n FROM members WHERE role = 'admin' AND revoked_at IS NULL",
    ]),
  ) as { results: { n: number }[] }[];
  if ((admins[0]?.results[0]?.n ?? 0) > 0) {
    return [
      `The team server is at ${url}.`,
      "It already has an admin: join with your token, grenier team join <url> <token>.",
    ];
  }

  const { token, hash } = newTeamToken();
  await wrangler([
    "d1",
    "execute",
    values.name,
    "--remote",
    "--command",
    `INSERT INTO members (id, name, token_hash, role, created_at) VALUES ('${randomUUID()}', '${values.admin}', '${hash}', 'admin', ${Date.now()})`,
  ]);
  saveTeam(paths, url, token);
  return [
    `The team server is at ${url}, and this machine is its admin "${values.admin}".`,
    `Admin token (shown once; it is saved in ${join(paths.home, "team-token")}): ${token}`,
    "Invite teammates with: grenier team invite <name>. Share a repository with: grenier team share",
  ];
}

export async function team(argv: string[], io: Io, dependencies: TeamDependencies = {}): Promise<string[]> {
  const [action, ...rest] = argv;
  switch (action) {
    case "deploy":
      return deploy(rest, io, dependencies);

    case "join": {
      const [url, token, ...extra] = rest;
      if (!url || !token || extra.length > 0) throw new UsageError("team join takes: <url> <token>");
      let address: URL;
      try {
        address = new URL(url);
      } catch {
        throw new UsageError(`not a URL: ${url}`);
      }
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
      if (address.protocol !== "https:" && !loopback) throw new UsageError("the team server's address must use https");
      const me = await call<{ name: string; role: string }>(
        { url: address.origin, token, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
        "/api/me",
      );
      const { paths } = environment(io);
      saveTeam(paths, address.origin, token);
      return [`Joined ${address.origin} as ${me.name} (${me.role}).`, "Share a repository with: grenier team share"];
    }

    case "invite": {
      const { values, positionals } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: true,
        options: { admin: { type: "boolean", default: false } },
      });
      const [name] = positionals;
      if (!name || positionals.length > 1) throw new UsageError("team invite takes: <name> [--admin]");
      const client = needTeam(io, dependencies.fetch);
      const invited = await call<{ name: string; role: string; token: string }>(client, "/api/members", {
        body: { name, role: values.admin ? "admin" : "member" },
      });
      return [
        `Invited ${invited.name} (${invited.role}). Send them this command; the token is shown once:`,
        `grenier team join ${client.url} ${invited.token}`,
      ];
    }

    case "share":
    case "unshare": {
      const { values } = parseArgs({ args: rest, strict: true, options: { repo: { type: "string" } } });
      const repo = await repoFor(io, values.repo);
      const { paths } = environment(io);
      return withStore(paths, async (store) => {
        if (action === "share") {
          await store.team.share(repo.id, repo.root, Date.now());
          return [
            `Sharing ${repo.root} with the team: its answers and summaries go to the team server at the next sync.`,
          ];
        }
        return [(await store.team.unshare(repo.id)) ? `Stopped sharing ${repo.root}.` : `${repo.root} was not shared.`];
      });
    }

    case "status": {
      const { paths, config } = environment(io);
      const client = teamClient(config, paths, io.env);
      const repos = await withStore(paths, (store) => store.team.repos());
      const lastSync = await withStore(paths, (store) => store.team.get("last_sync"));
      if (!client) return ["No team. Join one with: grenier team join <url> <token>"];
      const me = await call<{ name: string; role: string }>(
        { ...client, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
        "/api/me",
      );
      return [
        `team      ${client.url}, as ${me.name} (${me.role})`,
        `shared    ${repos.length === 0 ? "nothing yet (grenier team share)" : repos.map((repo) => repo.root).join(", ")}`,
        `synced    ${lastSync ? new Date(Number(lastSync)).toISOString() : "not yet"}`,
      ];
    }

    case "budget": {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        options: { team: { type: "string" }, member: { type: "string" } },
      });
      const client = needTeam(io, dependencies.fetch);
      const change: Record<string, number | null> = {};
      for (const scope of ["team", "member"] as const) {
        const value = values[scope];
        if (value === undefined) continue;
        const amount = value === "off" ? null : Number(value);
        if (amount !== null && (!Number.isFinite(amount) || amount < 0 || value.trim() === "")) {
          throw new UsageError(`--${scope} takes an amount in dollars, or "off"`);
        }
        change[scope] = amount;
      }
      if (Object.keys(change).length > 0) await call(client, "/api/budget", { method: "PUT", body: change });
      const budget = await call<TeamBudget>(client, "/api/budget");
      const line = (label: string, entry: { limit: number | null; spent: number }) =>
        `${label.padEnd(8)}$${entry.spent.toFixed(2)} spent today (UTC), ${entry.limit === null ? "no limit" : `limit $${entry.limit.toFixed(2)}`}`;
      return [line("team", budget.team), line("you", budget.member)];
    }

    case "sync": {
      const { paths, config } = environment(io);
      const client = needTeam(io, dependencies.fetch);
      const prices = loadPrices(config.prices);
      const result = await withStore(paths, async (store) => {
        try {
          const done = await syncOnce({
            store,
            embedder: await embedderLoader(config, paths, io.err)(),
            team: client,
            savedOf: (row) => cacheSavingsOf(row.model, row.cacheReadTokens ?? 0, prices),
            shareAll: config.cache.share_with_team,
          });
          await store.team.set("last_sync", String(Date.now()));
          return done;
        } catch (error) {
          if (error instanceof TeamError) throw new CommandError(error.message);
          throw error;
        }
      });
      return [
        `Pushed ${result.pushed.answers} answer(s), ${result.pushed.summaries} summary(ies), ${result.pushed.usageRows} usage row(s).`,
        `Pulled ${result.pulled.answers} answer(s), ${result.pulled.summaries} summary(ies); removed ${result.pulled.removed}.`,
      ];
    }

    default:
      throw new UsageError("team takes: deploy, join, invite, share, unshare, status, budget or sync");
  }
}
