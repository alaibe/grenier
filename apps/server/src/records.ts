import { ftsMatch, searchWords } from "@grenier/core";
import { builtinType, MEMBER_WRITES, memberMay, recordProblem } from "@grenier/core/records";
import { meTop, RECORD_PARTS } from "@grenier/core/team";
import {
  type Applied,
  type Change,
  type Device,
  jsonBody,
  type Member,
  problem,
  type Row,
  type StoredRecord,
  type TeamApp,
  type TeamData,
} from "./data.ts";
import { schedule } from "./work.ts";

/** What a change may set: the parts it carries, and the seal of a `me` record. */
const RECORD_FIELDS: readonly string[] = [...RECORD_PARTS, "sealed"];
const MAX_BATCH = 500;

export function recordFrom(row: Row): StoredRecord {
  return {
    id: row.id as string,
    top: row.top as string,
    type: row.type as string,
    kind: (row.kind as string | null) ?? null,
    title: row.title as string,
    folder: (row.folder as string | null) ?? "",
    body: row.body as string,
    fields: JSON.parse(row.fields as string),
    author: row.author as string,
    device: (row.device as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    retiredAt: (row.retired_at as number | null) ?? null,
    version: row.version as number,
    anchors: JSON.parse(row.anchors as string),
    links: JSON.parse(row.links as string),
    sealed: (row.sealed as string | null) ?? null,
  };
}

export function getRecord(team: Pick<TeamData, "one">, id: string): StoredRecord | undefined {
  const row = team.one("SELECT * FROM records WHERE id = ?", id);
  return row ? recordFrom(row) : undefined;
}

export function putRecord(team: Pick<TeamData, "sql">, record: StoredRecord, author: string, device: string): void {
  team.sql("DELETE FROM records_fts WHERE id = ?", record.id);
  team.sql(
    `INSERT INTO records (id, top, type, kind, title, folder, body, fields, author, device, session_id, created_at,
      updated_at, retired_at, version, anchors, links, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET top = excluded.top, type = excluded.type, kind = excluded.kind,
      title = excluded.title, folder = excluded.folder, body = excluded.body, fields = excluded.fields, author = excluded.author,
      device = excluded.device, session_id = excluded.session_id, updated_at = excluded.updated_at,
      retired_at = excluded.retired_at, version = excluded.version, anchors = excluded.anchors,
      links = excluded.links, sealed = excluded.sealed`,
    record.id,
    record.top,
    record.type,
    record.kind,
    record.title,
    record.folder,
    record.body,
    JSON.stringify(record.fields),
    record.author,
    record.device,
    record.sessionId,
    record.createdAt,
    record.updatedAt,
    record.retiredAt,
    record.version,
    JSON.stringify(record.anchors),
    JSON.stringify(record.links),
    record.sealed,
  );
  if (record.sealed === null && record.retiredAt === null) {
    team.sql("INSERT INTO records_fts (id, title, body) VALUES (?, ?, ?)", record.id, record.title, record.body);
  }
  const { sealed: _sealed, ...snapshot } = record;
  team.sql(
    "INSERT OR IGNORE INTO history (record_id, version, author, device, ts, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
    record.id,
    record.version,
    author,
    device,
    record.updatedAt,
    JSON.stringify(record.sealed === null ? snapshot : { sealed: true }),
  );
}

/** Whether a change touches a part someone else changed since its base version: the editor's save refuses then. */
function collides(team: TeamData, change: Change, changed: string[]): boolean {
  const since = team.sql(
    "SELECT snapshot FROM history WHERE record_id = ? AND version > ? ORDER BY version",
    change.recordId,
    change.baseVersion,
  );
  const base = team.one(
    "SELECT snapshot FROM history WHERE record_id = ? AND version = ?",
    change.recordId,
    change.baseVersion,
  );
  const before = base ? (JSON.parse(base.snapshot as string) as Record<string, unknown>) : {};
  const touched = new Set<string>();
  for (const entry of since) {
    const snapshot = JSON.parse(entry.snapshot as string) as Record<string, unknown>;
    for (const name of RECORD_FIELDS) {
      if (JSON.stringify(snapshot[name]) !== JSON.stringify(before[name])) touched.add(name);
    }
  }
  return changed.some((name) => touched.has(name));
}

/** Applies one change, field by field over what the store has; the store's order decides between two writers. */
function apply(team: TeamData, change: Change, member: Member, device: Device): Applied {
  const done = team.one("SELECT version FROM applied WHERE change_id = ?", change.id);
  if (done) return { version: done.version as number };
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
      kind: null,
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
      team.one("SELECT 1 AS ran FROM runs WHERE task_id = ? AND device_id = ?", current.id, device.id) !== undefined;
    if (!memberMay(current, next, mine, ran)) return { refused: MEMBER_WRITES };
  }
  if (!tops.includes(next.top)) {
    if (!next.top.startsWith("repo:")) return { refused: `there is no top folder ${next.top} you may write to` };
    team.sql(
      "INSERT OR IGNORE INTO tops (id, name, kind, repo_id) VALUES (?, ?, 'repo', ?)",
      next.top,
      typeof incoming.topName === "string" ? incoming.topName : next.top.slice(5, 13),
      next.top.slice(5),
    );
  }
  if (next.sealed !== null && !next.top.startsWith("me:")) return { refused: "only a record in me is sealed" };
  if (next.sealed !== null && next.folder !== "") return { refused: "a sealed record keeps its folder sealed" };
  if (next.sealed === null) {
    const why = recordProblem(next, builtinType(next.type));
    if (why) return { refused: why };
  }
  next.author = member.name;
  next.device = device.name;
  next.sessionId = typeof incoming.sessionId === "string" ? incoming.sessionId : null;
  next.updatedAt = now;
  next.version = team.nextVersion();
  putRecord(team, next, member.name, device.name);
  team.sql("INSERT INTO applied (change_id, version, at) VALUES (?, ?, ?)", change.id, next.version, now);
  // An admin changed the routine: every machine that declined its tasks may answer again.
  if (next.type === "Routine") {
    team.sql(
      "DELETE FROM declines WHERE task_id IN (SELECT id FROM records WHERE type = 'Task' AND json_extract(fields, '$.routine') = ?)",
      next.id,
    );
  }
  if (next.type === "Task" && next.fields.status === "to-do") team.sql("DELETE FROM claims WHERE task_id = ?", next.id);
  return { version: next.version };
}

/** The records' routes: changes sent and taken, a record's history, the list and search, and who has one open. */
export function recordRoutes(app: TeamApp, team: TeamData): void {
  /** Who has which record open in an editor, by record id: kept in memory, gone after a minute without news. */
  const open = new Map<string, Map<string, { member: string; device: string; at: number }>>();

  app.post("/api/changes", async (c) => {
    const body = await jsonBody<{ changes?: Change[] }>(c);
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (changes.length > MAX_BATCH) return problem(400, `send at most ${MAX_BATCH} changes at once`);
    const applied: { id: string; recordId: string; version: number }[] = [];
    const refused: { id: string; reason: string }[] = [];
    const conflicts: { id: string; current: StoredRecord }[] = [];
    for (const change of changes) {
      if (typeof change?.id !== "string" || typeof change.recordId !== "string" || !Array.isArray(change.changed)) {
        refused.push({ id: String(change?.id ?? ""), reason: "a change needs id, recordId, changed and record" });
        continue;
      }
      const result = team.storage.transactionSync(() => apply(team, change, c.get("member"), c.get("device")));
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
    const rows = team.sql("SELECT * FROM records WHERE version > ? ORDER BY version LIMIT ?", after, limit);
    const last = rows.at(-1)?.version as number | undefined;
    return c.json({
      records: rows.map(recordFrom).filter((record) => tops.includes(record.top)),
      next: last ?? Math.max(after, 0),
      version: team.version(),
      tops: team
        .sql("SELECT id, name, kind, repo_id FROM tops")
        .filter((top) => tops.includes(top.id as string))
        .map((top) => ({ id: top.id, name: top.name, kind: top.kind, repoId: top.repo_id })),
    });
  });

  app.get("/api/records/:id/history", (c) => {
    const record = getRecord(team, c.req.param("id"));
    if (!record || !team.topsOf(c.get("member")).includes(record.top)) return problem(404, "no such record");
    return c.json({
      history: team
        .sql(
          "SELECT version, author, device, ts, snapshot FROM history WHERE record_id = ? ORDER BY version",
          record.id,
        )
        .map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot as string) })),
    });
  });

  app.get("/api/records", (c) => {
    const tops = team.topsOf(c.get("member"));
    const { q = "", type = "", top = "" } = c.req.query();
    const words = searchWords(q.trim());
    // Filtered before the LIMIT, so a type or top folder with older records still gets them.
    const where = [
      `r.top IN (${tops.map(() => "?").join(", ")})`,
      "r.retired_at IS NULL AND r.sealed IS NULL",
      "(? = '' OR r.type = ?) AND (? = '' OR r.top = ?)",
    ].join(" AND ");
    const bindings = [...tops, type, type, top, top];
    const rows = words.length
      ? team.sql(
          `SELECT r.* FROM records_fts f JOIN records r ON r.id = f.id WHERE records_fts MATCH ? AND ${where} ORDER BY bm25(records_fts) LIMIT 200`,
          ftsMatch(words),
          ...bindings,
        )
      : team.sql(`SELECT r.* FROM records r WHERE ${where} ORDER BY r.updated_at DESC LIMIT 500`, ...bindings);
    return c.json({ records: rows.map(recordFrom) });
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
