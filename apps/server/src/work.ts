import { nextDue, taskFor } from "@grenier/core/routines";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, min, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bodyAs,
  type Device,
  problem,
  randomId,
  SEEN,
  type StoredRecord,
  type TeamApp,
  type TeamData,
} from "./data.ts";
import { claims, declines, devices, members, records, runs, schedules } from "./db/schema.ts";

const LEASE = 5 * 60 * 1000;
/** How long a machine that declined a routine's task is not offered it again. */
const DECLINE_LIFE = 30 * 60 * 1000;

const field = (name: string) => sql`json_extract(${records.fields}, ${`$.${name}`})`;

/** How machines take the tasks of scheduled routines and report their runs. */
/** A run as its machine reports it. */
const Run = z.object({
  id: z.string("a run needs id and routineId"),
  routineId: z.string("a run needs id and routineId"),
  taskId: z.string().optional(),
  status: z.string().default("running"),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  actions: z.number().default(0),
  cost: z.number().default(0),
});

export function workRoutes(app: TeamApp, team: TeamData): void {
  const { db } = team;

  app.post("/api/work/claim", (c) => c.json({ offer: db.transaction(() => offer(team, c.get("device"))) }));

  app.post("/api/work/:task/decline", (c) => {
    const taskId = c.req.param("task");
    const deviceId = c.get("device").id;
    db.delete(claims)
      .where(and(eq(claims.taskId, taskId), eq(claims.deviceId, deviceId)))
      .run();
    db.insert(declines)
      .values({ taskId, deviceId, at: Date.now() })
      .onConflictDoUpdate({ target: [declines.taskId, declines.deviceId], set: { at: sql`excluded.at` } })
      .run();
    return c.json({ declined: taskId });
  });

  app.post("/api/work/:task/renew", (c) => {
    const renewed = db
      .update(claims)
      .set({ leasedUntil: Date.now() + LEASE })
      .where(and(eq(claims.taskId, c.req.param("task")), eq(claims.deviceId, c.get("device").id)))
      .returning({ taskId: claims.taskId })
      .all();
    return renewed.length > 0 ? c.json({ renewed: true }) : problem(409, "this machine no longer holds the task");
  });

  app.post("/api/runs", async (c) => {
    const run = await bodyAs(c, Run);
    if (run instanceof Response) return run;
    const device = c.get("device").id;
    const known = db
      .select({ deviceId: runs.deviceId, taskId: runs.taskId })
      .from(runs)
      .where(eq(runs.id, run.id))
      .get();
    if (known && known.deviceId !== device) return problem(403, "this run is another machine's");
    const taskId = known ? known.taskId : (run.taskId ?? null);
    const holds = (task: string) =>
      db
        .select({ taskId: claims.taskId })
        .from(claims)
        .where(and(eq(claims.taskId, task), eq(claims.deviceId, device), gte(claims.leasedUntil, Date.now())))
        .get() !== undefined;
    // A task's run lets a member write that task's run fields, so only the machine holding the task starts one.
    if (!known && taskId !== null && !holds(taskId)) return problem(409, "this machine does not hold the task");
    const { status } = run;
    const ended = { status, endedAt: run.endedAt ?? null, actions: run.actions, cost: run.cost };
    db.insert(runs)
      .values({
        id: run.id,
        routineId: run.routineId,
        taskId,
        deviceId: device,
        startedAt: run.startedAt ?? Date.now(),
        ...ended,
      })
      .onConflictDoUpdate({ target: runs.id, set: ended })
      .run();
    if (taskId !== null && status !== "running") {
      db.delete(claims)
        .where(and(eq(claims.taskId, taskId), eq(claims.deviceId, device)))
        .run();
    }
    return c.json({ ok: true });
  });

  app.get("/api/runs", (c) => {
    const routine = c.req.query("routine");
    const rows = db
      .select({
        id: runs.id,
        routine_id: runs.routineId,
        task_id: runs.taskId,
        device_id: runs.deviceId,
        status: runs.status,
        started_at: runs.startedAt,
        ended_at: runs.endedAt,
        actions: runs.actions,
        cost: runs.cost,
        machine: devices.name,
      })
      .from(runs)
      .innerJoin(devices, eq(devices.id, runs.deviceId))
      .where(routine === undefined ? undefined : eq(runs.routineId, routine))
      .orderBy(desc(runs.startedAt))
      .limit(200)
      .all();
    return c.json({ runs: rows });
  });
}

/** The oldest task this machine can run, unless an available machine that could run it has more room. */
function offer(team: TeamData, device: Device): { task: StoredRecord; routine: StoredRecord } | null {
  const { db } = team;
  const now = Date.now();
  db.delete(claims).where(lt(claims.leasedUntil, now)).run();
  db.delete(declines)
    .where(lt(declines.at, now - DECLINE_LIFE))
    .run();
  const machine = { id: devices.id, room: devices.room, agents: devices.agents, memberId: devices.memberId };
  const me = db
    .select({ ...machine, state: devices.state })
    .from(devices)
    .where(eq(devices.id, device.id))
    .get();
  if (me?.state !== "available") return null;
  const machines = db
    .select(machine)
    .from(devices)
    .where(and(eq(devices.state, "available"), isNull(devices.revokedAt), gt(devices.stateAt, now - SEEN)))
    .all();
  const tasks = db
    .select()
    .from(records)
    .where(
      and(
        eq(records.type, "Task"),
        isNull(records.retiredAt),
        isNull(records.sealed),
        eq(field("status"), "to-do"),
        isNotNull(field("routine")),
        notInArray(records.id, db.select({ taskId: claims.taskId }).from(claims)),
        notInArray(
          records.id,
          db.select({ taskId: declines.taskId }).from(declines).where(eq(declines.deviceId, device.id)),
        ),
      ),
    )
    .orderBy(asc(records.createdAt))
    .all();
  // A task and its routine go only to the machines of someone who reads both their top folders.
  const tops = new Map<string, string[]>();
  const reads = (memberId: string, top: string) => {
    if (!tops.has(memberId)) {
      const member = db.select({ id: members.id }).from(members).where(eq(members.id, memberId)).get();
      tops.set(memberId, member ? team.topsOf({ id: memberId }) : []);
    }
    return tops.get(memberId)?.includes(top) ?? false;
  };
  for (const task of tasks) {
    const routine = team.get(String(task.fields.routine));
    if (!routine || routine.retiredAt !== null) continue;
    // A collector gathers what its person's agent can reach: it runs on that person's machines only.
    const person = typeof routine.fields.owner === "string" ? routine.fields.owner : routine.author;
    const owner =
      routine.fields.collector === "yes"
        ? (db
            .select({ id: members.id })
            .from(members)
            .where(and(eq(members.name, person), isNull(members.removedAt)))
            .get()?.id ?? null)
        : undefined;
    if (owner === null || (owner !== undefined && owner !== device.memberId)) continue;
    const can = (candidate: { memberId: string; agents: string[] }) => {
      if (owner !== undefined && candidate.memberId !== owner) return false;
      if (!reads(candidate.memberId, task.top) || !reads(candidate.memberId, routine.top)) return false;
      const agent = typeof routine.fields.agent === "string" ? routine.fields.agent : "claude";
      return candidate.agents.includes(agent);
    };
    if (!can(me)) continue;
    const declined = new Set(
      db
        .select({ deviceId: declines.deviceId })
        .from(declines)
        .where(eq(declines.taskId, task.id))
        .all()
        .map((row) => row.deviceId),
    );
    const best = machines
      .filter((candidate) => can(candidate) && !declined.has(candidate.id))
      .sort((a, b) => b.room - a.room)[0];
    if (best && best.id !== device.id && best.room > me.room) continue;
    db.insert(claims)
      .values({ taskId: task.id, deviceId: device.id, leasedUntil: now + LEASE, offeredAt: now })
      .run();
    return { task, routine };
  }
  return null;
}

/** Each scheduled routine's next run, and the alarm set for the soonest. */
export async function schedule(team: TeamData): Promise<void> {
  const { db } = team;
  const now = Date.now();
  const scheduled = new Set<string>();
  const routines = db
    .select()
    .from(records)
    .where(
      and(eq(records.type, "Routine"), isNull(records.retiredAt), isNull(records.sealed), ne(field("schedule"), "")),
    )
    .all();
  for (const routine of routines) {
    const next = nextDue(String(routine.fields.schedule ?? ""), now);
    if (next === null) continue;
    scheduled.add(routine.id);
    // A changed schedule that falls sooner takes effect now; a later one, after the run already due.
    db.insert(schedules)
      .values({ routineId: routine.id, nextAt: next })
      .onConflictDoUpdate({
        target: schedules.routineId,
        set: { nextAt: sql`min(${schedules.nextAt}, excluded.next_at)` },
      })
      .run();
  }
  for (const row of db.select({ routineId: schedules.routineId }).from(schedules).all()) {
    if (!scheduled.has(row.routineId)) db.delete(schedules).where(eq(schedules.routineId, row.routineId)).run();
  }
  const soonest = db
    .select({ at: min(schedules.nextAt) })
    .from(schedules)
    .get()?.at;
  if (soonest) await team.storage.setAlarm(soonest);
  else await team.storage.deleteAlarm();
}

/** Files the task of each scheduled routine that is due, unless the last one it filed is still waiting. */
export async function fileDue(team: TeamData): Promise<void> {
  const { db } = team;
  const now = Date.now();
  for (const row of db.select().from(schedules).where(lte(schedules.nextAt, now)).all()) {
    const routine = team.get(row.routineId);
    if (routine && routine.retiredAt === null) {
      const waiting = db
        .select({ id: records.id })
        .from(records)
        .where(
          and(
            eq(records.type, "Task"),
            isNull(records.retiredAt),
            eq(field("routine"), routine.id),
            eq(field("status"), "to-do"),
            eq(records.author, "schedule"),
          ),
        )
        .get();
      if (!waiting)
        file(
          team,
          routine,
          `${routine.title}, ${new Date(row.nextAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
        );
    }
    const next = nextDue(String(routine?.fields.schedule ?? ""), now);
    if (next === null) db.delete(schedules).where(eq(schedules.routineId, row.routineId)).run();
    else db.update(schedules).set({ nextAt: next }).where(eq(schedules.routineId, row.routineId)).run();
  }
  team.notify();
  await schedule(team);
}

/** A routine's task, filed by the store itself when its schedule falls due. */
function file(team: TeamData, routine: StoredRecord, title: string): void {
  const now = Date.now();
  const task: StoredRecord = {
    id: randomId(),
    folder: "",
    author: "schedule",
    device: "schedule",
    sessionId: null,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    version: team.nextVersion(),
    anchors: [],
    sealed: null,
    ...taskFor(routine, title, ""),
  };
  team.put(task, "schedule", "schedule");
}
