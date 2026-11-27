import { and, asc, count, eq, gt, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import { bodyAs, liveState, type TeamApp, type TeamData } from "./data.ts";
import { devices, members, runs, usage } from "./db/schema.ts";

export interface MachineState {
  state: "available" | "busy" | "away" | "offline";
  room: number;
  agents: string[];
}

/** A machine's usage for a day and repository: a count it can't vouch for reads as 0. */
const tally = z.number().finite().nonnegative().catch(0);
const UsageRow = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  repo: z
    .string()
    .catch("")
    .transform((repo) => repo.slice(0, 200)),
  requests: tally,
  inputTokens: tally,
  cacheWriteTokens: tally,
  cacheReadTokens: tally,
  outputTokens: tally,
  cost: tally,
  routineMinutes: tally,
});

const STATES: readonly string[] = ["available", "busy", "away", "offline"];

/** What a machine says of itself, over its live connection or in a request. */
export function setState(team: Pick<TeamData, "db">, deviceId: string, state: MachineState): void {
  if (!STATES.includes(state.state)) return;
  team.db
    .update(devices)
    .set({
      state: state.state,
      room: Number.isFinite(state.room) ? Math.max(0, Math.min(1, state.room)) : 0,
      agents: Array.isArray(state.agents) ? state.agents.slice(0, 10).map(String) : [],
      stateAt: Date.now(),
    })
    .where(eq(devices.id, deviceId))
    .run();
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
      machines: team.db
        .select({
          id: devices.id,
          name: devices.name,
          member: members.name,
          state: devices.state,
          stateAt: devices.stateAt,
          lastSeen: devices.lastSeen,
        })
        .from(devices)
        .innerJoin(members, eq(members.id, devices.memberId))
        .where(and(isNull(devices.revokedAt), isNull(members.removedAt)))
        .orderBy(asc(devices.name))
        .all()
        .map((row) => ({
          id: row.id,
          name: row.name,
          member: row.member,
          state: liveState(row),
          lastSeen: row.lastSeen,
          runs: team.db
            .select({ n: count() })
            .from(runs)
            .where(and(eq(runs.deviceId, row.id), gt(runs.startedAt, Date.now() - 30 * 86_400_000)))
            .get()?.n,
        })),
    }),
  );

  app.put("/api/usage", async (c) => {
    const body = await bodyAs(c, z.object({ rows: z.array(z.unknown()).default([]) }));
    if (body instanceof Response) return body;
    const rows = body.rows.slice(0, 2000);
    for (const given of rows) {
      // A row without a day is skipped, not the whole batch.
      const read = UsageRow.safeParse(given);
      if (!read.success) continue;
      const { day, repo, ...totals } = read.data;
      team.db
        .insert(usage)
        .values({ deviceId: c.get("device").id, day, repo, ...totals })
        .onConflictDoUpdate({ target: [usage.deviceId, usage.day, usage.repo], set: totals })
        .run();
    }
    return c.json({ kept: rows.length });
  });

  /** Usage by person, machine, day and repo: a member's own, every machine's for an admin. */
  app.get("/api/usage", (c) => {
    const member = c.get("member");
    const since = c.req.query("since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = team.db
      .select({
        device_id: usage.deviceId,
        day: usage.day,
        repo: usage.repo,
        requests: usage.requests,
        input_tokens: usage.inputTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        cache_read_tokens: usage.cacheReadTokens,
        output_tokens: usage.outputTokens,
        cost: usage.cost,
        routine_minutes: usage.routineMinutes,
        machine: devices.name,
        member: members.name,
      })
      .from(usage)
      .innerJoin(devices, eq(devices.id, usage.deviceId))
      .innerJoin(members, eq(members.id, devices.memberId))
      .where(and(gte(usage.day, since), member.role === "admin" ? undefined : eq(devices.memberId, member.id)))
      .orderBy(asc(usage.day), asc(members.name), asc(devices.name))
      .all();
    return c.json({ usage: rows });
  });
}
