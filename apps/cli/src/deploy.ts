import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Config } from "@grenier/core";
import { MEMBER_NAME } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { type TeamClient, TeamError, teamApi } from "@grenier/index";
import type { Store } from "@grenier/store";
import { Refusal } from "./io.ts";
import { deviceName } from "./runtime.ts";
import { enterTeam, newTeamToken } from "./team.ts";

const CLOUDFLARE = "https://api.cloudflare.com/client/v4";

class TokenRefused extends Refusal {}

export interface DeployDeps {
  paths: GrenierPaths;
  config: Config;
  store: Store;
  /** The built Worker: dist/server beside the CLI's bundle. */
  serverDir: string;
  /** Whether this machine is in a team now: only then may it update a Worker the account has already. */
  inTeam: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function keptDeployToken(paths: GrenierPaths): string {
  return existsSync(paths.deployToken) ? readFileSync(paths.deployToken, "utf8").trim() : "";
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
    throw new Refusal(`cannot reach Cloudflare: ${error.message}`);
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
    const Problem = response.status === 401 || response.status === 403 ? TokenRefused : Refusal;
    throw new Problem(`Cloudflare refused it: ${said || `HTTP ${response.status}`}`);
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
  const sleep = deps.sleep ?? ((ms: number) => wait(ms).then(() => undefined));
  // A token that worked is kept, so the next update needs none.
  const given = input.token.trim();
  const token = given || keptDeployToken(deps.paths);
  if (!token) throw new Refusal("paste an API token from Cloudflare");
  if (!/^[a-z0-9-]{1,63}$/.test(input.name))
    throw new Refusal("the store's name takes lowercase letters, digits and -");
  if (!MEMBER_NAME.test(input.member)) throw new Refusal("your name takes letters, digits and . _ @ -");

  const accounts = await cloudflare<{ id: string }[]>(fetchImpl, token, "/accounts").catch((error: unknown) => {
    // A kept token that stopped working is forgotten, so the next update asks for a new one.
    if (!given && error instanceof TokenRefused) rmSync(deps.paths.deployToken, { force: true });
    throw error;
  });
  if (accounts.length !== 1) {
    throw new Refusal(
      accounts.length === 0
        ? "the token reaches no Cloudflare account"
        : "the token reaches several accounts: make one for the account the team store goes in",
    );
  }
  const account = (accounts[0] as { id: string }).id;
  const scripts = await cloudflare<{ id: string }[]>(fetchImpl, token, `/accounts/${account}/workers/scripts`);
  const exists = scripts.some((script) => script.id === input.name);
  // The upload replaces the store's setup hash: a machine outside it must not touch a store it never joined.
  if (exists && !deps.inTeam) {
    throw new Refusal(
      `a Worker named ${input.name} exists in this account: pick another name, or join it with an invite`,
    );
  }

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
  if (given) writeFileSync(deps.paths.deployToken, `${token}\n`, { mode: 0o600 });
  await cloudflare(fetchImpl, token, `/accounts/${account}/workers/scripts/${input.name}/subdomain`, {
    json: { enabled: true },
  });
  const { subdomain } = await cloudflare<{ subdomain?: string }>(
    fetchImpl,
    token,
    `/accounts/${account}/workers/subdomain`,
  );
  if (!subdomain)
    throw new Refusal("the account has no workers.dev subdomain yet: choose one in Cloudflare's Workers page");
  const url = `https://${input.name}.${subdomain}.workers.dev`;

  // A new Worker takes a few seconds to answer at its address.
  const team: TeamClient = { url, token: setup.token, fetch: fetchImpl };
  for (let attempt = 1; ; attempt++) {
    try {
      await teamApi(team, "/api/setup", { body: { member: input.member, device: deviceName(deps.config) } });
      break;
    } catch (error) {
      if (error instanceof TeamError && error.status === 409) return { url, team: null };
      // Cloudflare serves the version before for a few seconds, with the setup hash before: wait it out.
      if (attempt >= 60) {
        const said = error instanceof TeamError ? ` (it answered ${error.status}: ${error.detail})` : "";
        throw new Refusal(`deployed at ${url}, but it does not answer yet${said}: try again in a minute`);
      }
      await sleep(2000);
    }
  }
  await enterTeam(deps.paths, deps.store, { url, token: setup.token, member: input.member, role: "admin" });
  return { url, team: { url, token: setup.token } };
}
