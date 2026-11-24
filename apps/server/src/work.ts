import { sha256 } from "@grenier/core/policy";
import { nextDue, taskFor } from "@grenier/core/routines";
import {
  adminOnly,
  type Device,
  type Member,
  problem,
  type Row,
  randomId,
  SEEN,
  type StoredRecord,
  type TeamApp,
  type TeamData,
} from "./data.ts";

const LEASE = 5 * 60 * 1000;
/** How long a machine that declined a request is not offered it again. */
const DECLINE_LIFE = 30 * 60 * 1000;

/** How machines take requests and report their runs, and how another tool's webhook files a request. */
export function workRoutes(app: TeamApp, team: TeamData): void {
  app.post("/api/work/claim", (c) =>
    c.json({ offer: team.storage.transactionSync(() => offer(team, c.get("device"))) }),
  );

  app.post("/api/work/:task/decline", (c) => {
    team.sql("DELETE FROM claims WHERE task_id = ? AND device_id = ?", c.req.param("task"), c.get("device").id);
    team.sql(
      "INSERT INTO declines (task_id, device_id, at) VALUES (?, ?, ?) ON CONFLICT (task_id, device_id) DO UPDATE SET at = excluded.at",
      c.req.param("task"),
      c.get("device").id,
      Date.now(),
    );
    return c.json({ declined: c.req.param("task") });
  });

  app.post("/api/work/:task/renew", (c) => {
    const renewed = team.storage.sql.exec(
      "UPDATE claims SET leased_until = ? WHERE task_id = ? AND device_id = ?",
      Date.now() + LEASE,
      c.req.param("task"),
      c.get("device").id,
    ).rowsWritten;
    return renewed > 0 ? c.json({ renewed: true }) : problem(409, "this machine no longer holds the task");
  });

  app.post("/api/runs", async (c) => {
    const run = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    if (typeof run.id !== "string" || typeof run.routineId !== "string")
      return problem(400, "a run needs id and routineId");
    const device = c.get("device").id;
    const known = team.one("SELECT device_id, task_id FROM runs WHERE id = ?", run.id);
    if (known && known.device_id !== device) return problem(403, "this run is another machine's");
    const taskId = known ? (known.task_id as string | null) : typeof run.taskId === "string" ? run.taskId : null;
    const holds = (task: string) =>
      team.one(
        "SELECT 1 AS held FROM claims WHERE task_id = ? AND device_id = ? AND leased_until >= ?",
        task,
        device,
        Date.now(),
      ) !== undefined;
    // A task's run lets a member write that task's run fields, so only the machine holding the task starts one.
    if (!known && taskId !== null && !holds(taskId)) return problem(409, "this machine does not hold the task");
    const status = String(run.status ?? "running");
    team.sql(
      `INSERT INTO runs (id, routine_id, task_id, device_id, status, started_at, ended_at, actions, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, actions = excluded.actions,
           cost = excluded.cost`,
      run.id,
      run.routineId,
      taskId,
      device,
      status,
      Number(run.startedAt ?? Date.now()),
      typeof run.endedAt === "number" ? run.endedAt : null,
      Number(run.actions ?? 0),
      Number(run.cost ?? 0),
    );
    if (taskId !== null && status !== "running") {
      team.sql("DELETE FROM claims WHERE task_id = ? AND device_id = ?", taskId, device);
    }
    return c.json({ ok: true });
  });

  app.get("/api/runs", (c) => {
    const routine = c.req.query("routine");
    const rows = team.sql(
      `SELECT r.*, d.name AS machine FROM runs r JOIN devices d ON d.id = r.device_id
         WHERE (? IS NULL OR r.routine_id = ?) ORDER BY r.started_at DESC LIMIT 200`,
      routine ?? null,
      routine ?? null,
    );
    return c.json({ runs: rows });
  });

  app.post("/api/webhooks", adminOnly, async (c) => {
    const { routine } = await c.req.json<{ routine?: unknown }>().catch(() => ({}) as { routine?: unknown });
    const target = typeof routine === "string" ? team.get(routine) : undefined;
    if (target?.type !== "Routine") return problem(404, "no such routine");
    const id = randomId(8);
    const secret = randomId(24);
    team.sql(
      "INSERT INTO webhooks (id, secret_hash, routine_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      await sha256(secret),
      target.id,
      c.get("member").name,
      Date.now(),
    );
    return c.json({ path: `/hooks/${id}/${secret}` }, 201);
  });

  // A webhook from another tool becomes a request for its routine. Its own secret URL is its only credential.
  app.post("/hooks/:id/:secret", async (c) => {
    const hook = team.one("SELECT * FROM webhooks WHERE id = ?", c.req.param("id"));
    if (!hook || hook.secret_hash !== (await sha256(c.req.param("secret")))) return problem(404, "no such webhook");
    const routine = team.get(hook.routine_id as string);
    if (!routine || routine.retiredAt !== null) return problem(410, "its routine is retired");
    const text = (await c.req.text()).slice(0, 100_000);
    let title = "Request from a webhook";
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const candidate =
        data.title ?? (data.data as Record<string, unknown> | undefined)?.title ?? data.text ?? data.subject;
      if (typeof candidate === "string" && candidate.trim()) title = candidate.trim().slice(0, 200);
    } catch {
      if (text.trim()) title = text.trim().split("\n")[0]?.slice(0, 200) ?? title;
    }
    const task = file(team, routine, title, `\`\`\`\n${text}\n\`\`\``, `webhook:${hook.id}`);
    team.notify();
    return c.json({ task: task.id }, 201);
  });
}

/** The oldest request this machine can run, unless an available machine that could run it has more room. */
function offer(team: TeamData, device: Device): { task: StoredRecord; routine: StoredRecord } | null {
  const now = Date.now();
  team.sql("DELETE FROM claims WHERE leased_until < ?", now);
  team.sql("DELETE FROM declines WHERE at < ?", now - DECLINE_LIFE);
  const me = team.one("SELECT state, room, repos, agents, member_id FROM devices WHERE id = ?", device.id);
  if (me?.state !== "available") return null;
  const machines = team.sql(
    "SELECT id, room, repos, agents, member_id FROM devices WHERE state = 'available' AND revoked_at IS NULL AND state_at > ?",
    now - SEEN,
  );
  const tasks = team
    .sql(
      `SELECT * FROM records WHERE type = 'Task' AND retired_at IS NULL AND sealed IS NULL
       AND json_extract(fields, '$.status') = 'to-do' AND json_extract(fields, '$.routine') IS NOT NULL
       AND id NOT IN (SELECT task_id FROM claims) AND id NOT IN (SELECT task_id FROM declines WHERE device_id = ?)
       ORDER BY created_at`,
      device.id,
    )
    .map((row) => team.record(row));
  // A request and its routine go only to the machines of someone who reads both their top folders.
  const tops = new Map<string, string[]>();
  const reads = (memberId: string, top: string) => {
    if (!tops.has(memberId)) {
      const member = team.one("SELECT id, name, role FROM members WHERE id = ?", memberId);
      tops.set(memberId, member ? team.topsOf(member as unknown as Member) : []);
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
        ? ((team.one("SELECT id FROM members WHERE name = ? AND removed_at IS NULL", person)?.id as
            | string
            | undefined) ?? null)
        : undefined;
    if (owner === null || (owner !== undefined && owner !== device.memberId)) continue;
    const can = (machine: Row) => {
      if (owner !== undefined && machine.member_id !== owner) return false;
      const member = machine.member_id as string;
      if (!reads(member, task.top) || !reads(member, routine.top)) return false;
      const repos = JSON.parse(machine.repos as string) as string[];
      const agents = JSON.parse(machine.agents as string) as string[];
      const repo = typeof routine.fields.repo === "string" ? routine.fields.repo : "";
      const agent = typeof routine.fields.agent === "string" ? routine.fields.agent : "claude";
      return (!repo || repos.includes(repo)) && agents.includes(agent);
    };
    if (!can(me)) continue;
    const declined = new Set(
      team.sql("SELECT device_id FROM declines WHERE task_id = ?", task.id).map((row) => row.device_id as string),
    );
    const best = machines
      .filter((machine) => can(machine) && !declined.has(machine.id as string))
      .sort((a, b) => (b.room as number) - (a.room as number))[0];
    if (best && best.id !== device.id && (best.room as number) > (me.room as number)) continue;
    team.sql(
      "INSERT INTO claims (task_id, device_id, leased_until, offered_at) VALUES (?, ?, ?, ?)",
      task.id,
      device.id,
      now + LEASE,
      now,
    );
    return { task, routine };
  }
  return null;
}

/** Each scheduled routine's next run, and the alarm set for the soonest. */
export async function schedule(team: TeamData): Promise<void> {
  const now = Date.now();
  const scheduled = new Set<string>();
  for (const row of team.sql(
    "SELECT * FROM records WHERE type = 'Routine' AND retired_at IS NULL AND sealed IS NULL AND json_extract(fields, '$.trigger') = 'schedule'",
  )) {
    const routine = team.record(row);
    const next = nextDue(String(routine.fields.schedule ?? ""), now);
    if (next === null) continue;
    scheduled.add(routine.id);
    // A changed schedule that falls sooner takes effect now; a later one, after the run already due.
    team.sql(
      "INSERT INTO schedules (routine_id, next_at) VALUES (?, ?) ON CONFLICT (routine_id) DO UPDATE SET next_at = min(next_at, excluded.next_at)",
      routine.id,
      next,
    );
  }
  for (const row of team.sql("SELECT routine_id FROM schedules")) {
    if (!scheduled.has(row.routine_id as string))
      team.sql("DELETE FROM schedules WHERE routine_id = ?", row.routine_id as string);
  }
  const soonest = team.one("SELECT min(next_at) AS at FROM schedules")?.at as number | null | undefined;
  if (soonest) await team.storage.setAlarm(soonest);
  else await team.storage.deleteAlarm();
}

/** Files the task of each scheduled routine that is due, unless the last one it filed is still waiting. */
export async function fileDue(team: TeamData): Promise<void> {
  const now = Date.now();
  for (const row of team.sql("SELECT routine_id, next_at FROM schedules WHERE next_at <= ?", now)) {
    const routine = team.get(row.routine_id as string);
    if (routine && routine.retiredAt === null) {
      const waiting = team.one(
        `SELECT id FROM records WHERE type = 'Task' AND retired_at IS NULL AND json_extract(fields, '$.routine') = ?
           AND json_extract(fields, '$.status') = 'to-do' AND author = 'schedule'`,
        routine.id,
      );
      if (!waiting)
        file(
          team,
          routine,
          `${routine.title}, ${new Date(row.next_at as number).toISOString().slice(0, 16).replace("T", " ")} UTC`,
          "",
          "schedule",
        );
    }
    const next = nextDue(String(routine?.fields.schedule ?? ""), now);
    if (next === null) team.sql("DELETE FROM schedules WHERE routine_id = ?", row.routine_id as string);
    else team.sql("UPDATE schedules SET next_at = ? WHERE routine_id = ?", next, row.routine_id as string);
  }
  team.notify();
  await schedule(team);
}

/** A request for a routine, filed by the store itself: from a schedule or another tool's webhook. */
function file(team: TeamData, routine: StoredRecord, title: string, body: string, by: string): StoredRecord {
  const now = Date.now();
  const member: Member = { id: by, name: by, role: "member" };
  const device: Device = { id: by, name: by, memberId: by };
  const task: StoredRecord = {
    id: randomId(),
    kind: null,
    folder: "",
    author: by,
    device: by,
    sessionId: null,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    version: team.nextVersion(),
    anchors: [],
    sealed: null,
    ...taskFor(routine, title, body),
  };
  team.put(task, member, device);
  return task;
}
