import { jsonBody, liveState, type TeamApp, type TeamData } from "./data.ts";

export interface MachineState {
  state: "available" | "busy" | "away" | "offline";
  room: number;
  agents: string[];
}

interface UsageRow {
  day: string;
  repo: string;
  requests: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
  routineMinutes: number;
}

const STATES: readonly string[] = ["available", "busy", "away", "offline"];

/** What a machine says of itself, over its live connection or in a request. */
export function setState(team: Pick<TeamData, "sql">, deviceId: string, state: MachineState): void {
  if (!STATES.includes(state.state)) return;
  team.sql(
    "UPDATE devices SET state = ?, room = ?, agents = ?, state_at = ? WHERE id = ?",
    state.state,
    Number.isFinite(state.room) ? Math.max(0, Math.min(1, state.room)) : 0,
    JSON.stringify(Array.isArray(state.agents) ? state.agents.slice(0, 10).map(String) : []),
    Date.now(),
    deviceId,
  );
}

/** The team's machines and what they spent: each machine reports its own totals, which replace the last ones. */
export function machineRoutes(app: TeamApp, team: TeamData): void {
  app.put("/api/machines/me", async (c) => {
    const state = await c.req.json<MachineState>().catch(() => ({ state: "offline" }) as MachineState);
    setState(team, c.get("device").id, state);
    return c.json({ ok: true });
  });

  app.get("/api/machines", (c) =>
    c.json({
      machines: team
        .sql(
          `SELECT d.id, d.name, m.name AS member, d.state, d.state_at, d.last_seen, d.room FROM devices d
           JOIN members m ON m.id = d.member_id WHERE d.revoked_at IS NULL AND m.removed_at IS NULL ORDER BY d.name`,
        )
        .map((row) => ({
          id: row.id,
          name: row.name,
          member: row.member,
          state: liveState(row),
          lastSeen: row.last_seen,
          runs: team.one(
            "SELECT count(*) AS n FROM runs WHERE device_id = ? AND started_at > ?",
            row.id as string,
            Date.now() - 30 * 86_400_000,
          )?.n,
        })),
    }),
  );

  app.put("/api/usage", async (c) => {
    const body = await jsonBody<{ rows?: UsageRow[] }>(c);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    for (const row of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.day))) continue;
      team.sql(
        `INSERT INTO usage (device_id, day, repo, requests, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost, routine_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, day, repo) DO UPDATE SET requests = excluded.requests,
         input_tokens = excluded.input_tokens, cache_write_tokens = excluded.cache_write_tokens,
         cache_read_tokens = excluded.cache_read_tokens, output_tokens = excluded.output_tokens, cost = excluded.cost,
         routine_minutes = excluded.routine_minutes`,
        c.get("device").id,
        String(row.day),
        String(row.repo ?? "").slice(0, 200),
        count(row.requests),
        count(row.inputTokens),
        count(row.cacheWriteTokens),
        count(row.cacheReadTokens),
        count(row.outputTokens),
        count(row.cost),
        count(row.routineMinutes),
      );
    }
    return c.json({ kept: rows.length });
  });

  /** Usage by person, machine, day and repo: a member's own, every machine's for an admin. */
  app.get("/api/usage", (c) => {
    const member = c.get("member");
    const since = c.req.query("since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = team.sql(
      `SELECT u.*, d.name AS machine, m.name AS member FROM usage u JOIN devices d ON d.id = u.device_id
       JOIN members m ON m.id = d.member_id WHERE u.day >= ? AND (? = 'admin' OR d.member_id = ?) ORDER BY u.day, m.name, d.name`,
      since,
      member.role,
      member.id,
    );
    return c.json({ usage: rows });
  });
}
