import { TEAM_PROTOCOL } from "@grenier/core";
import type { Overview, PausedSession, SessionRow } from "@grenier/core/api";
import { buildReport, mostSpentFirst, type Prices, parseSince, projectOf } from "@grenier/log";
import type { UsageWithSession } from "@grenier/store";
import { Hono } from "hono";
import { keptDeployToken } from "../deploy.ts";
import type { AdminDeps } from "./admin.ts";

function sessionReport(rows: readonly UsageWithSession[], prices: Prices): SessionRow[] {
  const sessions = new Map(rows.map((row) => [row.sessionId, row]));
  return buildReport(rows, "session", prices)
    .map((report) => {
      const session = sessions.get(report.key);
      return {
        ...report,
        client: session?.client ?? null,
        project: session ? projectOf(session) : null,
        startedAt: session?.startedAt ?? null,
      };
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** What the app opens on: the week's spend by day, project and session, and the sessions a loop paused. */
export function overviewRoutes(deps: AdminDeps): Hono {
  const { store, prices } = deps;
  const app = new Hono();

  app.get("/overview", async (c) => {
    const since = parseSince("7d", Date.now());
    const rows = await store.usage.list({ since });
    const team = deps.team();
    return c.json({
      version: deps.version,
      me: (await deps.storeDeps()).me.member,
      days: buildReport(rows, "day", prices),
      projects: mostSpentFirst(buildReport(rows, "repo", prices)),
      sessions: sessionReport(rows, prices),
      waiting: team ? new Set((await store.outbox.list()).map((entry) => entry.recordId)).size : 0,
      team: team ? { url: team.url, lastSync: Number((await store.state.get("last_sync")) ?? 0) || null } : null,
      role: team ? ((await store.state.get("team_role")) ?? null) : null,
      deployKept: keptDeployToken(deps.paths) !== "",
      outdated: team ? Number((await store.state.get("team_protocol")) ?? TEAM_PROTOCOL) < TEAM_PROTOCOL : false,
      paused: (await store.sessions.paused()).length,
    } satisfies Overview);
  });

  app.get("/sessions/paused", async (c) => {
    const loops = await store.events.list({ kind: "pause" });
    return c.json({
      sessions: (await store.sessions.paused()).map((session) => ({
        id: session.id,
        client: session.client,
        repo: projectOf(session),
        pausedAt: loops.filter((event) => event.sessionId === session.id).at(-1)?.ts ?? null,
      })) satisfies PausedSession[],
    });
  });

  app.post("/sessions/:id/resume", async (c) => {
    const session = await store.sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: `no session ${c.req.param("id")}` }, 404);
    if (!session.paused) return c.json({ resumed: null });
    await store.sessions.setPaused(session.id, false);
    await store.events.add({ sessionId: session.id, ts: Date.now(), kind: "resume", detail: null });
    return c.json({ resumed: session.id });
  });

  return app;
}
