import { ftsMatch, searchWords } from "@grenier/core";
import { builtinType, MEMBER_WRITES, memberMay, recordProblem } from "@grenier/core/records";
import { type ChangesAnswer, meTop, RECORD_PARTS } from "@grenier/core/team";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, sql } from "drizzle-orm";

import { z } from "zod";
import {
  type Applied,
  bodyAs,
  type Change,
  type Device,
  type Member,
  problem,
  type StoredRecord,
  type TeamApp,
  type TeamData,
} from "./data.ts";
import { recordsFts } from "./db/fts.ts";
import { applied, claims, declines, history, records, runs } from "./db/schema.ts";
import { viewOf } from "./markdown.ts";
import { schedule } from "./work.ts";

/** What a change may set: the parts it carries, and the seal of a `me` record. */
const RECORD_FIELDS: readonly string[] = [...RECORD_PARTS, "sealed"];
const MAX_BATCH = 500;

export function getRecord(team: Pick<TeamData, "db">, id: string): StoredRecord | undefined {
  return team.db.select().from(records).where(eq(records.id, id)).get();
}

export function putRecord(team: Pick<TeamData, "db">, record: StoredRecord, author: string, device: string): void {
  const { db } = team;
  db.delete(recordsFts).where(eq(recordsFts.id, record.id)).run();
  const { id: _id, createdAt: _createdAt, ...changed } = record;
  db.insert(records).values(record).onConflictDoUpdate({ target: records.id, set: changed }).run();
  if (record.sealed === null && record.retiredAt === null) {
    db.insert(recordsFts).values({ id: record.id, title: record.title, body: record.body }).run();
  }
  const { sealed: _sealed, ...snapshot } = record;
  db.insert(history)
    .values({
      recordId: record.id,
      version: record.version,
      author,
      device,
      ts: record.updatedAt,
      snapshot: record.sealed === null ? snapshot : { sealed: true },
    })
    .onConflictDoNothing()
    .run();
}

/** Whether a change touches a part someone else changed since its base version: the editor's save refuses then. */
function collides(team: TeamData, change: Change, changed: string[]): boolean {
  const since = team.db
    .select({ snapshot: history.snapshot })
    .from(history)
    .where(and(eq(history.recordId, change.recordId), gt(history.version, change.baseVersion)))
    .orderBy(asc(history.version))
    .all();
  const base = team.db
    .select({ snapshot: history.snapshot })
    .from(history)
    .where(and(eq(history.recordId, change.recordId), eq(history.version, change.baseVersion)))
    .get();
  const before = base?.snapshot ?? {};
  const touched = new Set<string>();
  for (const { snapshot } of since) {
    for (const name of RECORD_FIELDS) {
      if (JSON.stringify(snapshot[name]) !== JSON.stringify(before[name])) touched.add(name);
    }
  }
  return changed.some((name) => touched.has(name));
}

/** The records a member reads that match the words, best first, else the latest; none sealed or retired. */
export function searchRecords(
  team: Pick<TeamData, "db" | "topsOf">,
  member: Pick<Member, "id">,
  input: { query: string; type: string; top: string; limit: number },
): StoredRecord[] {
  const words = searchWords(input.query.trim());
  // Filtered before the LIMIT, so a type or top folder with older records still gets them.
  const where = and(
    inArray(records.top, team.topsOf(member)),
    isNull(records.retiredAt),
    isNull(records.sealed),
    input.type === "" ? undefined : eq(records.type, input.type),
    input.top === "" ? undefined : eq(records.top, input.top),
  );
  if (!words.length) {
    return team.db.select().from(records).where(where).orderBy(desc(records.updatedAt)).limit(input.limit).all();
  }
  return team.db
    .select(getTableColumns(records))
    .from(recordsFts)
    .innerJoin(records, eq(records.id, recordsFts.id))
    .where(and(sql`${recordsFts} MATCH ${ftsMatch(words)}`, where))
    .orderBy(sql`bm25(${recordsFts})`)
    .limit(input.limit)
    .all();
}

/** Applies one change, field by field over what the store has; the store's order decides between two writers. */
function apply(team: TeamData, change: Change, member: Member, device: Device): Applied {
  const done = team.db.select({ version: applied.version }).from(applied).where(eq(applied.changeId, change.id)).get();
  if (done) return { version: done.version };
  const tops = team.topsOf(member);
  const current = getRecord(team, change.recordId);
  if (current && !tops.includes(current.top)) return { refused: "this record is in a top folder you do not read" };
  const changed = change.changed.filter((name) => RECORD_FIELDS.includes(name));
  // Filed under Team by default, a new record that names no top folder could be someone's `me` page.
  if (!current && !changed.includes("top")) return { refused: "a new record names its top folder" };
  if (current && change.check && change.baseVersion < current.version && collides(team, change, changed)) {
    return { conflict: current };
  }
  const now = Date.now();
  const incoming = change.record as Record<string, unknown>;
  const next: StoredRecord = {
    ...(current ?? {
      id: change.recordId,
      top: "team",
      type: "Doc",
      title: "",
      folder: "",
      body: "",
      fields: {},
      author: member.name,
      device: device.name,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
      version: 0,
      anchors: [],
      links: [],
      sealed: null,
    }),
  };
  for (const name of changed) (next as unknown as Record<string, unknown>)[name] = incoming[name] ?? null;
  next.fields ??= {};
  next.anchors ??= [];
  next.links ??= [];
  next.title ??= "";
  next.folder ??= "";
  next.body ??= "";
  const mine = meTop(member.id);
  if (next.top === "me") next.top = mine;
  if (member.role !== "admin") {
    const ran =
      current?.type === "Task" &&
      team.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.taskId, current.id), eq(runs.deviceId, device.id)))
        .get() !== undefined;
    if (!memberMay(current, next, mine, ran)) return { refused: MEMBER_WRITES };
  }
  if (!tops.includes(next.top)) return { refused: `there is no top folder ${next.top} you may write to` };
  if (next.sealed !== null && !next.top.startsWith("me:")) return { refused: "only a record in me is sealed" };
  if (next.sealed !== null && next.folder !== "") return { refused: "a sealed record keeps its folder sealed" };
  // Retiring alone takes a record out whatever its shape: one its type's rules no longer fit must still go.
  const retiring = current?.retiredAt === null && changed.length === 1 && changed[0] === "retiredAt";
  if (next.sealed === null && !retiring) {
    const why = recordProblem(next, builtinType(next.type));
    if (why) return { refused: why };
  }
  next.author = member.name;
  next.device = device.name;
  next.sessionId = typeof incoming.sessionId === "string" ? incoming.sessionId : null;
  next.updatedAt = now;
  next.version = team.nextVersion();
  putRecord(team, next, member.name, device.name);
  team.db.insert(applied).values({ changeId: change.id, version: next.version, at: now }).run();
  // An admin changed the routine: every machine that declined its tasks may answer again.
  if (next.type === "Routine") {
    const tasks = team.db
      .select({ id: records.id })
      .from(records)
      .where(and(eq(records.type, "Task"), eq(sql`json_extract(${records.fields}, '$.routine')`, next.id)));
    team.db.delete(declines).where(inArray(declines.taskId, tasks)).run();
  }
  if (next.type === "Task" && next.fields.status === "to-do") {
    team.db.delete(claims).where(eq(claims.taskId, next.id)).run();
  }
  return { version: next.version };
}

/** The records' routes: changes sent and taken, a record's history, the list and search, and who has one open. */
export function recordRoutes(app: TeamApp, team: TeamData): void {
  /** Who has which record open in an editor, by record id: kept in memory, gone after a minute without news. */
  const open = new Map<string, Map<string, { member: string; device: string; at: number }>>();

  app.post("/api/changes", async (c) => {
    const body = await bodyAs(c, z.object({ changes: z.array(z.unknown()).default([]) }));
    if (body instanceof Response) return body;
    const changes = body.changes as Change[];
    if (changes.length > MAX_BATCH) return problem(400, `send at most ${MAX_BATCH} changes at once`);
    const { applied, refused, conflicts }: ChangesAnswer = { applied: [], refused: [], conflicts: [] };
    for (const change of changes) {
      if (typeof change?.id !== "string" || typeof change.recordId !== "string" || !Array.isArray(change.changed)) {
        refused.push({ id: String(change?.id ?? ""), reason: "a change needs id, recordId, changed and record" });
        continue;
      }
      const result = team.db.transaction(() => apply(team, change, c.get("member"), c.get("device")));
      if ("version" in result) applied.push({ id: change.id, recordId: change.recordId, version: result.version });
      else if ("refused" in result) refused.push({ id: change.id, reason: result.refused });
      else conflicts.push({ id: change.id, current: result.conflict });
    }
    if (applied.length > 0) {
      team.notify();
      await schedule(team);
    }
    return c.json({ applied, refused, conflicts });
  });

  app.get("/api/changes", (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? MAX_BATCH), MAX_BATCH);
    const tops = team.topsOf(c.get("member"));
    const rows = team.db
      .select()
      .from(records)
      .where(gt(records.version, after))
      .orderBy(asc(records.version))
      .limit(limit)
      .all();
    const last = rows.at(-1)?.version;
    return c.json({
      records: rows.filter((record) => tops.includes(record.top)),
      next: last ?? Math.max(after, 0),
      version: team.version(),
    });
  });

  // The web view draws a page from this, never from its Markdown as HTML.
  app.get("/api/records/:id/view", (c) => {
    const record = getRecord(team, c.req.param("id"));
    if (!record || !team.topsOf(c.get("member")).includes(record.top)) return problem(404, "no such record");
    return c.json({ view: viewOf(record.body) });
  });

  app.get("/api/records/:id/history", (c) => {
    const record = getRecord(team, c.req.param("id"));
    if (!record || !team.topsOf(c.get("member")).includes(record.top)) return problem(404, "no such record");
    return c.json({
      history: team.db
        .select({
          version: history.version,
          author: history.author,
          device: history.device,
          ts: history.ts,
          snapshot: history.snapshot,
        })
        .from(history)
        .where(eq(history.recordId, record.id))
        .orderBy(asc(history.version))
        .all(),
    });
  });

  app.get("/api/records", (c) => {
    const { q = "", type = "", top = "" } = c.req.query();
    return c.json({ records: searchRecords(team, c.get("member"), { query: q, type, top, limit: 500 }) });
  });

  // The editor says every few seconds that it has a record open, and hears who else has.
  app.put("/api/records/:id/open", (c) => {
    const now = Date.now();
    const id = c.req.param("id");
    const editors = open.get(id) ?? new Map();
    editors.set(c.get("device").id, { member: c.get("member").name, device: c.get("device").name, at: now });
    for (const [key, entry] of editors) if (entry.at < now - 60_000) editors.delete(key);
    open.set(id, editors);
    return c.json({
      others: [...editors.entries()]
        .filter(([key]) => key !== c.get("device").id)
        .map(([, entry]) => ({ member: entry.member, device: entry.device })),
    });
  });
}
