import { fileURLToPath } from "node:url";
import { joinCode, sha256 } from "@grenier/core";
import { type TeamClient, TeamError, teamApi } from "@grenier/index";
import { Hono } from "hono";
import { deployTeamStore } from "../deploy.ts";
import { Refusal } from "../io.ts";
import { deviceName, ensureBaseTops, ensurePersonalKey } from "../runtime.ts";
import { newTeamToken, parseInvite, saveTeam } from "../team.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** Where joining from the app stands: waiting for the admin to confirm the code, then joined or failed. */
interface Joining {
  state: "waiting" | "joined" | "failed";
  code?: string;
  error?: string;
  url?: string;
  member?: string;
}

/** The team store: its pages with this device's token, joining or deploying one, and a round of sync now. */
export function teamRoutes(deps: AdminDeps): Hono {
  const { store } = deps;
  const app = new Hono();
  let joining: Joining | null = null;

  app.all("/team/*", async (c) => {
    const team = deps.team();
    if (!team) return c.json({ error: "this machine is in no team: start or join one on the app's Team screen" }, 409);
    const path = c.req.path.replace(/^.*?\/team\//, "/api/");
    const body = c.req.method === "GET" || c.req.method === "DELETE" ? undefined : await c.req.json().catch(() => ({}));
    const search = new URL(c.req.url).search;
    return c.json(await teamApi(team, `${path}${search}`, { method: c.req.method, ...(body ? { body } : {}) }));
  });

  /** Joining from the app: the link, then the code to read to the admin, then the wait for their confirmation. */
  app.get("/join", (c) => c.json(joining ?? { state: "idle" }));

  app.post("/join", async (c) => {
    if (joining?.state === "waiting") return c.json({ error: "already waiting for a confirmation" }, 409);
    let invite: ReturnType<typeof parseInvite>;
    try {
      invite = parseInvite(String((await bodyOf(c)).link ?? ""));
    } catch (error) {
      if (error instanceof Refusal) return c.json({ error: error.message }, 400);
      throw error;
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
    if (response instanceof Error) return c.json({ error: `cannot reach ${invite.url}: ${response.message}` }, 502);
    const answer = (await response.json().catch(() => ({}))) as { error?: string; member?: string };
    if (!response.ok) return c.json({ error: answer.error ?? `HTTP ${response.status}` }, response.status as 400);
    const code = await joinCode(await sha256(invite.secret), nonce);
    joining = { state: "waiting", code, url: invite.url, ...(answer.member ? { member: answer.member } : {}) };
    const team: TeamClient = { url: invite.url, token, fetch: fetchImpl };
    const deadline = Date.now() + 10 * 60 * 1000;
    const poll = async () => {
      try {
        const me = await teamApi<{ name: string; me: string; role: string }>(team, "/api/me");
        saveTeam(deps.paths, invite.url, token);
        await store.state.set("team_member", me.name);
        await store.state.set("team_me_top", me.me);
        await store.state.set("team_role", me.role);
        await ensureBaseTops(store);
        ensurePersonalKey(deps.paths);
        joining = { state: "joined", url: invite.url, member: me.name };
        deps.joined({ url: invite.url, token });
        return;
      } catch (error) {
        if (!(error instanceof TeamError) || error.status !== 401) {
          joining = { state: "failed", error: (error as Error).message };
          return;
        }
      }
      if (Date.now() > deadline) {
        joining = { state: "failed", error: "no confirmation came in 10 minutes; ask for a new invite link" };
        return;
      }
      setTimeout(() => void poll(), 2000);
    };
    void poll();
    return c.json(joining, 202);
  });

  app.post("/deploy", async (c) => {
    const input = await bodyOf(c);
    const deployed = await deployTeamStore(
      {
        paths: deps.paths,
        config: deps.config,
        store,
        serverDir: fileURLToPath(new URL("./server/", import.meta.url)),
        inTeam: deps.team() !== null,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      },
      {
        token: String(input.token ?? ""),
        name: String(input.name ?? "grenier-team"),
        member: String(input.member ?? ""),
      },
    );
    if (deployed.team) deps.joined(deployed.team);
    return c.json({ url: deployed.url, created: deployed.team !== null });
  });

  app.post("/sync", async (c) => {
    if (!deps.team()) return c.json({ error: "this machine is in no team" }, 409);
    const result = await deps.sync();
    return result ? c.json(result) : c.json({ error: "the sync failed: the daemon's log says why" }, 502);
  });

  return app;
}
