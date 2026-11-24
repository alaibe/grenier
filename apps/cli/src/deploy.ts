import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { type TeamClient, TeamError, teamApi } from "@grenier/index";
import type { Store } from "@grenier/store";
import { CommandError } from "./io.ts";
import { deviceName, ensureBaseTops, ensurePersonalKey } from "./runtime.ts";
import { newTeamToken, saveTeam } from "./team.ts";

const CLOUDFLARE = "https://api.cloudflare.com/client/v4";

export interface DeployDeps {
  paths: GrenierPaths;
  config: Config;
  store: Store;
  /** The built Worker: dist/server beside the CLI's bundle. */
  serverDir: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** One call to Cloudflare's API; its errors say what Cloudflare said, never the token. */
async function cloudflare<T>(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  init: { method?: string; body?: FormData; json?: unknown } = {},
): Promise<T> {
  const response = await fetchImpl(`${CLOUDFLARE}${path}`, {
    method: init.method ?? (init.body || init.json ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.json === undefined ? (init.body ? { body: init.body } : {}) : { body: JSON.stringify(init.json) }),
  }).catch((error: Error) => {
    throw new CommandError(`cannot reach Cloudflare: ${error.message}`);
  });
  const answer = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    result?: T;
    errors?: { message?: string }[];
  };
  if (!response.ok || answer.success === false) {
    const said = (answer.errors ?? [])
      .map((error) => error.message)
      .filter(Boolean)
      .join("; ");
    throw new CommandError(`Cloudflare refused it: ${said || `HTTP ${response.status}`}`);
  }
  return answer.result as T;
}

/**
 * Puts the team store in the Cloudflare account an API token reaches, through Cloudflare's API: a new one makes this
 * machine its first admin; one that has its members already is updated in place, its records kept.
 */
export async function deployTeamStore(
  deps: DeployDeps,
  input: { token: string; name: string; member: string },
): Promise<{ url: string; team: TeamClient | null }> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const token = input.token.trim();
  if (!token) throw new CommandError("paste an API token from Cloudflare");
  if (!/^[a-z0-9-]{1,63}$/.test(input.name))
    throw new CommandError("the store's name takes lowercase letters, digits and -");
  if (!/^[\w.@-]{1,64}$/.test(input.member)) throw new CommandError("your name takes letters, digits and . _ @ -");

  const accounts = await cloudflare<{ id: string }[]>(fetchImpl, token, "/accounts");
  if (accounts.length !== 1) {
    throw new CommandError(
      accounts.length === 0
        ? "the token reaches no Cloudflare account"
        : "the token reaches several accounts: make one for the account the team store goes in",
    );
  }
  const account = (accounts[0] as { id: string }).id;
  const scripts = await cloudflare<{ id: string }[]>(fetchImpl, token, `/accounts/${account}/workers/scripts`);
  const exists = scripts.some((script) => script.id === input.name);

  const setup = newTeamToken();
  const metadata = {
    main_module: "server.js",
    compatibility_date: "2026-11-01",
    bindings: [
      { type: "durable_object_namespace", name: "TEAM", class_name: "TeamStore" },
      { type: "plain_text", name: "SETUP_HASH", text: setup.hash },
    ],
    ...(exists ? {} : { migrations: { new_tag: "v1", new_sqlite_classes: ["TeamStore"] } }),
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    "server.js",
    new Blob([readFileSync(join(deps.serverDir, "server.js"), "utf8")], { type: "application/javascript+module" }),
    "server.js",
  );
  await cloudflare(fetchImpl, token, `/accounts/${account}/workers/scripts/${input.name}`, {
    method: "PUT",
    body: form,
  });
  await cloudflare(fetchImpl, token, `/accounts/${account}/workers/scripts/${input.name}/subdomain`, {
    json: { enabled: true },
  });
  const { subdomain } = await cloudflare<{ subdomain?: string }>(
    fetchImpl,
    token,
    `/accounts/${account}/workers/subdomain`,
  );
  if (!subdomain)
    throw new CommandError("the account has no workers.dev subdomain yet: choose one in Cloudflare's Workers page");
  const url = `https://${input.name}.${subdomain}.workers.dev`;

  // A new Worker takes a few seconds to answer at its address.
  const team: TeamClient = { url, token: setup.token, fetch: fetchImpl };
  for (let attempt = 1; ; attempt++) {
    try {
      await teamApi(team, "/api/setup", { body: { member: input.member, device: deviceName(deps.config) } });
      break;
    } catch (error) {
      if (error instanceof TeamError && error.status === 409) return { url, team: null };
      if (attempt >= 15)
        throw new CommandError(`deployed at ${url}, but it does not answer yet: try again in a minute`);
      await sleep(2000);
    }
  }
  saveTeam(deps.paths, url, setup.token);
  await deps.store.state.set("team_member", input.member);
  await deps.store.state.set("team_role", "admin");
  await ensureBaseTops(deps.store);
  ensurePersonalKey(deps.paths);
  return { url, team: { url, token: setup.token } };
}
