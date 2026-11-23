import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { joinCode, sha256 } from "@grenier/core";
import { syncOnce, type TeamClient, TeamError, teamApi } from "@grenier/index";
import { embedderLoader } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { deviceName, ensureBaseSpaces, ensurePersonalKey, personalKey } from "../runtime.ts";
import { newTeamToken, saveTeam, teamClient, withTomlValue } from "../team.ts";

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
  /** Waits between two checks while a join waits for its confirmation. */
  sleep?: (ms: number) => Promise<void>;
}

function needTeam(io: Io, fetchImpl?: typeof fetch): TeamClient {
  const { paths, config } = environment(io);
  const team = teamClient(config, paths, io.env);
  if (!team)
    throw new CommandError("no team yet: run grenier team deploy, or open an invite link (grenier team join <link>)");
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

/** An invite link as `grenier team invite` makes it: `grenier://join/<host>/<invite>/<secret>`. */
export function inviteLink(url: string, invite: string, secret: string): string {
  return `grenier://join/${new URL(url).host}/${invite}/${secret}`;
}

export function parseInvite(link: string): { url: string; invite: string; secret: string } {
  const match = /^grenier:\/\/join\/([\w.:-]+)\/([0-9a-f]+)\/([0-9a-f]+)\/?$/.exec(link.trim());
  if (!match) throw new UsageError("an invite link looks like grenier://join/<host>/<invite>/<secret>");
  const host = match[1] as string;
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  return { url: `${local ? "http" : "https"}://${host}`, invite: match[2] as string, secret: match[3] as string };
}

/** `grenier team deploy`: the team store into the logged-in Cloudflare account, then this machine as its first admin. */
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
  const deployed = await wrangler(["deploy"]).catch((error: Error) => {
    // Cloudflare's 10064: the Worker already exists with Durable Objects of a class this one lacks, as Grenier 0.1.5's.
    if (!/\[code: 10064\]/.test(error.message)) throw error;
    throw new CommandError(
      `a Worker named ${values.name} already runs in this Cloudflare account with Durable Objects this team store cannot take over. Deploy under another name (grenier team deploy --name <name>), or delete that Worker and its data first: cd ${dir} && npx --yes wrangler@${WRANGLER_VERSION} delete --name ${values.name}`,
    );
  });
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deployed)?.[0];
  if (!url) throw new CommandError(`deployed, but Wrangler printed no workers.dev address:\n${deployed}`);

  const team: TeamClient = { url, token, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) };
  try {
    await teamApi(team, "/api/setup", { body: { member, device: deviceName(config) } });
  } catch (error) {
    if (error instanceof TeamError && error.status === 409) {
      return [
        `The team store is at ${url}, and already has its members.`,
        "Ask an admin for an invite link, then open it here: grenier team join <link>",
      ];
    }
    throw new CommandError(`deployed at ${url}, but setting up the first admin failed: ${(error as Error).message}`);
  }
  saveTeam(paths, url, token);
  await withStore(paths, async (store) => {
    await store.state.set("team_member", member);
    await ensureBaseSpaces(store);
  });
  ensurePersonalKey(paths);
  return [
    `The team store is at ${url}, in your own Cloudflare account. This machine is ${deviceName(config)}, and you are its admin, ${member}.`,
    "Invite teammates with: grenier team invite <name>",
  ];
}

/** `grenier team join <link>`: asks to join with a token made here; it works once an admin confirms the code. */
async function join(argv: string[], io: Io, dependencies: TeamDependencies): Promise<string[]> {
  const [link, ...extra] = argv;
  if (!link || extra.length > 0) throw new UsageError("team join takes the invite link");
  const { url, invite, secret } = parseInvite(link);
  const { paths, config } = environment(io);
  const { token, hash } = newTeamToken();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const fetchImpl = dependencies.fetch ?? fetch;
  const response = await fetchImpl(new URL("/api/join", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite, secret, device: deviceName(config), tokenHash: hash, nonce }),
  }).catch((error: Error) => {
    throw new CommandError(`cannot reach ${url}: ${error.message}`);
  });
  const answer = (await response.json().catch(() => ({}))) as { error?: string; member?: string };
  if (!response.ok) throw new CommandError(answer.error ?? `HTTP ${response.status}`);
  const code = await joinCode(await sha256(secret), nonce);
  io.err(`Your code: ${code.slice(0, 3)} ${code.slice(3)}`);
  io.err("Read it to the person who invited you; they confirm it with: grenier team confirm <code>");
  io.err("Waiting for their confirmation (up to 10 minutes)…");
  const team: TeamClient = { url, token, fetch: fetchImpl };
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    try {
      const me = await teamApi<{ name: string; role: string; me: string }>(team, "/api/me");
      saveTeam(paths, url, token);
      await withStore(paths, async (store) => {
        await store.state.set("team_member", me.name);
        await store.state.set("team_me_space", me.me);
        await ensureBaseSpaces(store);
      });
      const hasKey = personalKey(paths) !== null;
      ensurePersonalKey(paths);
      return [
        `Joined ${url} as ${me.name} (${me.role}), on ${deviceName(config)}.`,
        hasKey
          ? "Your personal key is here already."
          : "If you have another machine in this team, copy its personal key here (grenier key on it, then grenier key set <key> here) so your `me` records open on both.",
      ];
    } catch (error) {
      if (!(error instanceof TeamError) || error.status !== 401) throw new CommandError((error as Error).message);
    }
    if (Date.now() > deadline) throw new CommandError("no confirmation came in 10 minutes; ask for a new invite link");
    await sleep(2000);
  }
}

export async function team(argv: string[], io: Io, dependencies: TeamDependencies = {}): Promise<string[]> {
  const [action, ...rest] = argv;
  switch (action) {
    case "deploy":
      return deploy(rest, io, dependencies);
    case "join":
      return join(rest, io, dependencies);

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
      const invited = await call<{ id: string; secret: string; member: string; newMember: boolean }>(
        client,
        "/api/invites",
        { body: { name, role: values.admin ? "admin" : "member" } },
      );
      return [
        `Send this link to ${invited.member} (it works once, for 24 hours):`,
        inviteLink(client.url, invited.id, invited.secret),
        "They open it in the desktop app, or run grenier team join <link>; then both screens show a six-digit code.",
        "When they read you the same code: grenier team confirm <code>",
      ];
    }

    case "pending": {
      const client = needTeam(io, dependencies.fetch);
      const { invites } = await call<{
        invites: { member: string; device: string | null; code: string | null; expiresAt: number }[];
      }>(client, "/api/invites");
      if (invites.length === 0) return ["No invite waiting."];
      return invites.map(
        (invite) =>
          `${invite.member.padEnd(20)} ${invite.device ? `${invite.device}, code ${invite.code ?? "expired"}` : "link not opened yet"}`,
      );
    }

    case "confirm": {
      const code = rest.join("").replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) throw new UsageError("team confirm takes the six-digit code the new device shows");
      const client = needTeam(io, dependencies.fetch);
      const joined = await call<{ joined: string; device: string }>(client, "/api/invites/confirm", { body: { code } });
      return [`${joined.joined} joined, on ${joined.device}.`];
    }

    case "members": {
      const client = needTeam(io, dependencies.fetch);
      const { members } = await call<{
        members: { name: string; role: string; devices: { name: string; state: string }[] }[];
      }>(client, "/api/members");
      return members.map(
        (member) =>
          `${member.name.padEnd(20)} ${member.role.padEnd(7)} ${member.devices.map((device) => `${device.name} (${device.state})`).join(", ")}`,
      );
    }

    case "role": {
      const [name, role] = rest;
      if (!name || (role !== "admin" && role !== "member"))
        throw new UsageError("team role takes: <name> admin|member");
      const client = needTeam(io, dependencies.fetch);
      await call(client, `/api/members/${encodeURIComponent(name)}/role`, { method: "PUT", body: { role } });
      return [`${name} is ${role === "admin" ? "an admin" : "a member"} now.`];
    }

    case "remove": {
      const [name] = rest;
      if (!name) throw new UsageError("team remove takes a member's name");
      const client = needTeam(io, dependencies.fetch);
      await call(client, `/api/members/${encodeURIComponent(name)}`, { method: "DELETE" });
      return [`Removed ${name}: their devices stop at their next call.`];
    }

    case "machines": {
      const client = needTeam(io, dependencies.fetch);
      const { machines } = await call<{ machines: { name: string; member: string; state: string; runs: number }[] }>(
        client,
        "/api/machines",
      );
      return machines.map(
        (machine) =>
          `${machine.name.padEnd(20)} ${machine.member.padEnd(16)} ${machine.state.padEnd(10)} ${machine.runs ?? 0} run(s) in 30 days`,
      );
    }

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

    case "status": {
      const { paths, config } = environment(io);
      const client = teamClient(config, paths, io.env);
      if (!client)
        return ["No team. Make one with grenier team deploy, or open an invite link: grenier team join <link>"];
      const me = await call<{ name: string; role: string; device: string }>(
        { ...client, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) },
        "/api/me",
      );
      const { lastSync, waiting } = await withStore(paths, async (store) => ({
        lastSync: await store.state.get("last_sync"),
        waiting: (await store.outbox.list()).length,
      }));
      return [
        `team      ${client.url}, as ${me.name} (${me.role}) on ${me.device}`,
        `synced    ${lastSync ? new Date(Number(lastSync)).toISOString() : "not yet"}`,
        `waiting   ${waiting} change(s) not yet on the team store`,
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
      throw new UsageError(
        "team takes: deploy, join <link>, invite <name>, pending, confirm <code>, members, role, remove, machines, rename, spaces, web, webhook, status or sync",
      );
  }
}
