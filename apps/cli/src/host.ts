import { blobText, repoText } from "@grenier/connectors/git";
import { type Config, joinCode, repoSpace, sha256 } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { type StoreDeps, type TeamClient, TeamError, teamApi } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { fetchSkill, searchSkills } from "./catalog.ts";
import { parseInvite } from "./commands/team.ts";
import { autoInstall, install, rollback, type Shared, share, sharedList, uninstall } from "./installs.ts";
import { deviceName, ensureBaseSpaces, ensurePersonalKey } from "./runtime.ts";
import { newTeamToken, saveTeam } from "./team.ts";

export type Reply = { status: number; body: unknown } | null;
export type Route = (method: string, path: string, body: unknown) => Promise<Reply>;

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const no = (status: number, error: string): Reply => ({ status, body: { error } });

/** Joining a team from the desktop app: the link, then the code to read to the admin, then the wait. */
export function joining(deps: {
  paths: GrenierPaths;
  config: Config;
  store: Store;
  fetch?: typeof fetch;
  /** Called once the admin confirmed: the daemon starts its link to the team store. */
  joined: (team: TeamClient) => void;
}): Route {
  let state: {
    state: "waiting" | "joined" | "failed";
    code?: string;
    error?: string;
    url?: string;
    member?: string;
  } | null = null;
  return async (method, path, body) => {
    if (path !== "/join") return null;
    if (method === "GET") return ok(state ?? { state: "idle" });
    if (method !== "POST") return null;
    if (state?.state === "waiting") return no(409, "already waiting for a confirmation");
    let invite: ReturnType<typeof parseInvite>;
    try {
      invite = parseInvite(String((body as { link?: unknown } | undefined)?.link ?? ""));
    } catch (error) {
      return no(400, (error as Error).message);
    }
    const fetchImpl = deps.fetch ?? fetch;
    const { token, hash } = newTeamToken();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const response = await fetchImpl(new URL("/api/join", invite.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invite: invite.invite,
        secret: invite.secret,
        device: deviceName(deps.config),
        tokenHash: hash,
        nonce,
      }),
    }).catch((error: Error) => error);
    if (response instanceof Error) return no(502, `cannot reach ${invite.url}: ${response.message}`);
    const answer = (await response.json().catch(() => ({}))) as { error?: string; member?: string };
    if (!response.ok) return no(response.status, answer.error ?? `HTTP ${response.status}`);
    const code = await joinCode(await sha256(invite.secret), nonce);
    state = { state: "waiting", code, url: invite.url, ...(answer.member ? { member: answer.member } : {}) };
    const team: TeamClient = { url: invite.url, token, fetch: fetchImpl };
    const deadline = Date.now() + 10 * 60 * 1000;
    const poll = async () => {
      try {
        const me = await teamApi<{ name: string; me: string }>(team, "/api/me");
        saveTeam(deps.paths, invite.url, token);
        await deps.store.state.set("team_member", me.name);
        await deps.store.state.set("team_me_space", me.me);
        await ensureBaseSpaces(deps.store);
        ensurePersonalKey(deps.paths);
        state = { state: "joined", url: invite.url, member: me.name };
        deps.joined({ url: invite.url, token });
        return;
      } catch (error) {
        if (!(error instanceof TeamError) || error.status !== 401) {
          state = { state: "failed", error: (error as Error).message };
          return;
        }
      }
      if (Date.now() > deadline) {
        state = { state: "failed", error: "no confirmation came in 10 minutes; ask for a new invite link" };
        return;
      }
      setTimeout(() => void poll(), 2000);
    };
    void poll();
    return ok(state, 202);
  };
}

/** A stale anchor's file: the version the record was written from, and the one there is now. */
export function anchorDiffs(store: Store): Route {
  return async (method, path) => {
    const match = /^\/records\/([^/]+)\/diff\?path=(.+)$/.exec(path);
    if (method !== "GET" || !match) return null;
    const record = await store.records.get(decodeURIComponent(match[1] as string));
    const file = decodeURIComponent(match[2] as string);
    const anchor = record?.anchors.find((entry) => entry.kind === "git" && entry.ref === file);
    if (!record || !anchor?.repoId) return no(404, "no such file among the record's anchors");
    const root = (await store.spaces.get(repoSpace(anchor.repoId)))?.root;
    if (!root) return no(404, "this repository is not on this machine");
    const before = await blobText(root, anchor.version);
    const now = await repoText(root, file);
    return ok({ path: file, before, now });
  };
}

/** The team's skills and servers on this machine, and skills from skills.sh, shared from GitHub like any other. */
export function installs(
  store: Store,
  home: string,
  catalog: { deps: () => Promise<StoreDeps>; fetch?: typeof fetch },
): Route {
  return async (method, path, body) => {
    if (path.startsWith("/installs/search?") && method === "GET") {
      const words = new URLSearchParams(path.slice(path.indexOf("?"))).get("q") ?? "";
      try {
        return ok({ skills: await searchSkills(words, catalog.fetch) });
      } catch (error) {
        return no(502, (error as Error).message);
      }
    }
    if (path === "/installs/share" && method === "POST") {
      const { source, name } = (body ?? {}) as { source?: unknown; name?: unknown };
      if (typeof source !== "string" || typeof name !== "string") return no(400, "share takes a source and a name");
      try {
        const skill = await fetchSkill(source, name, catalog.fetch);
        const shared = await share(await catalog.deps(), {
          type: "Skill",
          title: skill.name,
          body: "",
          fields: { files: skill.files },
        });
        return ok({ ...shared, title: skill.name, files: Object.keys(skill.files).length });
      } catch (error) {
        return no(409, (error as Error).message);
      }
    }
    if (path === "/installs" && method === "GET") {
      return ok({ shared: await sharedList(store), auto: (await store.state.get("auto_install")) === "on" });
    }
    if (path === "/installs/auto" && method === "PUT") {
      const on = (body as { on?: unknown } | undefined)?.on === true;
      await store.state.set("auto_install", on ? "on" : "off");
      return ok({ auto: on, done: on ? await autoInstall(store, home) : [] });
    }
    const match = /^\/installs\/([^/?]+)(\/rollback)?$/.exec(path);
    if (!match) return null;
    const record = await store.records.get(decodeURIComponent(match[1] as string));
    if (!record || (record.type !== "Skill" && record.type !== "McpServer") || record.retiredAt !== null) {
      return no(404, "no such skill or MCP server");
    }
    try {
      if (match[2] && method === "POST") return ok(await rollback(store, home, record as FullRecord));
      if (method === "POST") return ok(await install(store, home, record as FullRecord));
      if (method === "DELETE")
        return ok({ removed: await uninstall(store, { id: record.id, type: record.type as Shared }) });
    } catch (error) {
      return no(409, (error as Error).message);
    }
    return null;
  };
}

/** The first route that answers. */
export function routes(...list: Route[]): Route {
  return async (method, path, body) => {
    for (const route of list) {
      const reply = await route(method, path, body);
      if (reply) return reply;
    }
    return null;
  };
}
