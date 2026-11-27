import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql, sum } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrations as allMigrations, type Migration, StoreError } from "./index.ts";
import * as schema from "./schema.ts";
import type { FullRecord, RecordFilter, Store } from "./store.ts";

type Db = BetterSQLite3Database<typeof schema>;

export interface SqliteStoreOptions {
  migrations?: readonly Migration[];
}

const BUSY_TIMEOUT = 5000;

/** SQLite refuses a concurrent switch to WAL at once, ignoring the busy timeout, so the losers retry. */
function useWal(sqlite: Database.Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT;
  for (;;) {
    try {
      sqlite.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "SQLITE_BUSY" || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/** Opens (or creates, readable by this user only) the database at `file` and brings its schema up to date. */
export function openSqliteStore(file: string, options: SqliteStoreOptions = {}): Store {
  if (file !== ":memory:") closeSync(openSync(file, "a", 0o600));

  const sqlite = new Database(file);
  const db = drizzle(sqlite, { schema });
  try {
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT}`);
    useWal(sqlite);
    sqlite.pragma("foreign_keys = ON");
    migrate(sqlite, db, file, options.migrations ?? allMigrations);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const {
    sessions,
    usage,
    events,
    state,
    repos,
    records,
    anchors,
    links,
    recordEmbeddings,
    history,
    outbox,
    approvals,
    runs,
    clients,
    toolUses,
    transcripts,
  } = schema;

  const ftsQuery = (terms: readonly string[]) =>
    terms
      .filter((term) => term.trim() !== "")
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(" OR ");

  const full = (rows: (typeof records.$inferSelect)[]): FullRecord[] => {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const anchorRows = db
      .select()
      .from(anchors)
      .where(inArray(anchors.recordId, ids))
      .orderBy(asc(anchors.kind), asc(anchors.ref))
      .all();
    const linkRows = db
      .select()
      .from(links)
      .where(inArray(links.recordId, ids))
      .orderBy(asc(links.kind), asc(links.ref))
      .all();
    return rows.map((row) => ({
      ...row,
      anchors: anchorRows
        .filter((anchor) => anchor.recordId === row.id)
        .map(({ kind, repoId, ref, version }) => ({ kind, repoId, ref, version })),
      links: linkRows.filter((link) => link.recordId === row.id).map(({ kind, ref }) => ({ kind, ref })),
    }));
  };

  const recordConditions = (filter: RecordFilter) =>
    and(
      filter.tops.length === 0 ? sql`0` : inArray(records.top, [...filter.tops]),
      filter.type === undefined ? undefined : eq(records.type, filter.type),
      filter.retired ? undefined : isNull(records.retiredAt),
      filter.linkedTo === undefined
        ? undefined
        : inArray(
            records.id,
            db
              .select({ id: links.recordId })
              .from(links)
              .where(and(eq(links.kind, filter.linkedTo.kind), eq(links.ref, filter.linkedTo.ref))),
          ),
    );

  return {
    close: async () => {
      sqlite.close();
    },

    sessions: {
      create: async (session) => {
        db.insert(sessions).values(session).onConflictDoNothing().run();
      },
      get: async (id) => db.select().from(sessions).where(eq(sessions.id, id)).get(),
      end: async (id, endedAt) => {
        db.update(sessions).set({ endedAt }).where(eq(sessions.id, id)).run();
      },
      setPaused: async (id, paused) => {
        db.update(sessions).set({ paused }).where(eq(sessions.id, id)).run();
      },
      paused: async () =>
        db.select().from(sessions).where(eq(sessions.paused, true)).orderBy(asc(sessions.startedAt)).all(),
    },

    usage: {
      add: async (row) => {
        db.insert(usage).values(row).run();
      },
      list: async (filter = {}) =>
        db
          .select({
            id: usage.id,
            sessionId: usage.sessionId,
            ts: usage.ts,
            model: usage.model,
            inputTokens: usage.inputTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            cacheReadTokens: usage.cacheReadTokens,
            outputTokens: usage.outputTokens,
            cost: usage.cost,
            status: usage.status,
            repoRoot: sessions.repoRoot,
            repoId: sessions.repoId,
            cwd: sessions.cwd,
            client: sessions.client,
            startedAt: sessions.startedAt,
          })
          .from(usage)
          .leftJoin(sessions, eq(sessions.id, usage.sessionId))
          .where(
            and(
              filter.since === undefined ? undefined : gte(usage.ts, filter.since),
              filter.sessionId === undefined ? undefined : eq(usage.sessionId, filter.sessionId),
            ),
          )
          .orderBy(asc(usage.ts), asc(usage.id))
          .all(),
      prune: async (before) => db.delete(usage).where(lt(usage.ts, before)).run().changes,
    },

    events: {
      add: async (event) => {
        db.insert(events).values(event).run();
      },
      list: async (filter = {}) =>
        db
          .select()
          .from(events)
          .where(filter.kind === undefined ? undefined : eq(events.kind, filter.kind))
          .orderBy(asc(events.ts), asc(events.id))
          .all(),
      prune: async (before) => db.delete(events).where(lt(events.ts, before)).run().changes,
    },

    state: {
      get: async (key) => db.select().from(state).where(eq(state.key, key)).get()?.value,
      set: async (key, value) => {
        db.insert(state).values({ key, value }).onConflictDoUpdate({ target: state.key, set: { value } }).run();
      },
    },

    repos: {
      put: async (repo) => {
        db.insert(repos)
          .values(repo)
          .onConflictDoUpdate({ target: repos.id, set: { root: repo.root } })
          .run();
      },
      get: async (id) => db.select().from(repos).where(eq(repos.id, id)).get(),
    },

    records: {
      put: async (record, embedding) => {
        const { anchors: anchorList, links: linkList, ...row } = record;
        sqlite
          .transaction(() => {
            const before = db
              .select({ title: records.title, body: records.body })
              .from(records)
              .where(eq(records.id, row.id))
              .get();
            db.insert(records).values(row).onConflictDoUpdate({ target: records.id, set: row }).run();
            db.delete(anchors).where(eq(anchors.recordId, row.id)).run();
            db.delete(links).where(eq(links.recordId, row.id)).run();
            if (anchorList.length > 0) {
              db.insert(anchors)
                .values(anchorList.map((anchor) => ({ ...anchor, recordId: row.id })))
                .onConflictDoNothing()
                .run();
            }
            if (linkList.length > 0) {
              db.insert(links)
                .values(linkList.map((link) => ({ ...link, recordId: row.id })))
                .onConflictDoNothing()
                .run();
            }
            if (embedding) {
              db.insert(recordEmbeddings)
                .values({ recordId: row.id, model: embedding.model, vector: toBlob(embedding.vector) })
                .onConflictDoUpdate({
                  target: recordEmbeddings.recordId,
                  set: { model: embedding.model, vector: toBlob(embedding.vector) },
                })
                .run();
            } else if (before && (before.title !== row.title || before.body !== row.body)) {
              db.delete(recordEmbeddings).where(eq(recordEmbeddings.recordId, row.id)).run();
            }
          })
          .immediate();
      },
      get: async (id) => full(db.select().from(records).where(eq(records.id, id)).all())[0],
      list: async (filter) =>
        full(
          db
            .select()
            .from(records)
            .where(recordConditions(filter))
            .orderBy(desc(records.updatedAt), desc(records.seq))
            .limit(filter.limit ?? 1000)
            .all(),
        ),
      search: async (terms, topIds, limit) => {
        const query = ftsQuery(terms);
        if (query === "" || topIds.length === 0) return [];
        return db
          .select({ id: records.id, score: sql<number>`bm25(records_fts)` })
          .from(sql`records_fts`)
          .innerJoin(records, sql`${records.seq} = records_fts.rowid`)
          .where(and(sql`records_fts MATCH ${query}`, inArray(records.top, [...topIds]), isNull(records.retiredAt)))
          .orderBy(sql`bm25(records_fts)`)
          .limit(limit)
          .all();
      },
      vectors: async (topIds, model) =>
        topIds.length === 0
          ? []
          : db
              .select({ id: recordEmbeddings.recordId, vector: recordEmbeddings.vector })
              .from(recordEmbeddings)
              .innerJoin(records, eq(records.id, recordEmbeddings.recordId))
              .where(
                and(inArray(records.top, [...topIds]), eq(recordEmbeddings.model, model), isNull(records.retiredAt)),
              )
              .all()
              .map((row) => ({ id: row.id, vector: fromBlob(row.vector) })),
      hit: async (id) => {
        db.update(records)
          .set({ hits: sql`${records.hits} + 1` })
          .where(eq(records.id, id))
          .run();
      },
      setVersion: async (id, version) => {
        db.update(records).set({ version }).where(eq(records.id, id)).run();
      },
      stats: async () =>
        db
          .select({
            top: records.top,
            type: records.type,
            records: count(),
            hits: sql<number>`coalesce(${sum(records.hits)}, 0)`,
          })
          .from(records)
          .where(isNull(records.retiredAt))
          .groupBy(records.top, records.type)
          .orderBy(asc(records.top), asc(records.type))
          .all()
          .map((row) => ({ ...row, hits: Number(row.hits) })),
    },

    history: {
      add: async (entry) => {
        db.insert(history).values(entry).onConflictDoNothing().run();
      },
      list: async (recordId) =>
        db.select().from(history).where(eq(history.recordId, recordId)).orderBy(asc(history.version)).all(),
    },

    outbox: {
      add: async (entry) => {
        const next =
          (db
            .select({ last: sql<number | null>`max(${outbox.seq})` })
            .from(outbox)
            .get()?.last ?? 0) + 1;
        db.insert(outbox)
          .values({ ...entry, seq: next })
          .run();
      },
      pending: async (limit, withoutMe = false) =>
        db
          .select()
          .from(outbox)
          .where(withoutMe ? sql`json_extract(${outbox.change}, '$.record.top') IS NOT 'me'` : undefined)
          .orderBy(asc(outbox.seq))
          .limit(limit)
          .all(),
      list: async () => db.select().from(outbox).orderBy(asc(outbox.seq)).all(),
      remove: async (ids) => {
        if (ids.length > 0)
          db.delete(outbox)
            .where(inArray(outbox.id, [...ids]))
            .run();
      },
    },

    approvals: {
      get: async (recordId, kind) =>
        db
          .select()
          .from(approvals)
          .where(and(eq(approvals.recordId, recordId), eq(approvals.kind, kind)))
          .get(),
      list: async (kind) =>
        db
          .select()
          .from(approvals)
          .where(kind === undefined ? undefined : eq(approvals.kind, kind))
          .orderBy(asc(approvals.approvedAt))
          .all(),
      put: async (approval) => {
        db.insert(approvals)
          .values(approval)
          .onConflictDoUpdate({ target: [approvals.recordId, approvals.kind], set: approval })
          .run();
      },
      remove: async (recordId, kind) => {
        db.delete(approvals)
          .where(and(eq(approvals.recordId, recordId), eq(approvals.kind, kind)))
          .run();
      },
    },

    runs: {
      add: async (run) => {
        db.insert(runs).values(run).run();
      },
      update: async (id, change) => {
        db.update(runs).set(change).where(eq(runs.id, id)).run();
      },
      list: async (filter = {}) =>
        db
          .select()
          .from(runs)
          .where(
            and(
              filter.routineId === undefined ? undefined : eq(runs.routineId, filter.routineId),
              filter.since === undefined ? undefined : gte(runs.startedAt, filter.since),
            ),
          )
          .orderBy(desc(runs.startedAt))
          .limit(filter.limit ?? 200)
          .all(),
    },

    clients: {
      add: async (client) => {
        db.insert(clients).values(client).run();
      },
      findActive: async (tokenHash) =>
        db
          .select()
          .from(clients)
          .where(and(eq(clients.tokenHash, tokenHash), isNull(clients.revokedAt)))
          .get(),
      list: async () => db.select().from(clients).orderBy(asc(clients.name)).all(),
      revoke: async (name, at) =>
        db
          .update(clients)
          .set({ revokedAt: at, name: `${name}~${at}` })
          .where(and(eq(clients.name, name), isNull(clients.revokedAt)))
          .run().changes > 0,
    },
    toolUses: {
      add: async (rows, offsets) => {
        const upsert = sqlite.prepare(
          `INSERT INTO tool_uses (day, agent, project, kind, subject, tool, calls, errors, last_at)
           VALUES (@day, @agent, @project, @kind, @subject, @tool, @calls, @errors, @lastAt)
           ON CONFLICT DO UPDATE SET calls = calls + excluded.calls, errors = errors + excluded.errors,
             last_at = max(last_at, excluded.last_at)`,
        );
        const read = sqlite.prepare(
          "INSERT INTO transcripts (path, offset) VALUES (?, ?) ON CONFLICT DO UPDATE SET offset = excluded.offset",
        );
        sqlite.transaction(() => {
          for (const row of rows) upsert.run(row);
          for (const [path, offset] of offsets) read.run(path, offset);
        })();
      },
      list: async ({ kind, subjects, since }) =>
        db
          .select()
          .from(toolUses)
          .where(
            and(
              eq(toolUses.kind, kind),
              subjects ? inArray(toolUses.subject, [...subjects]) : undefined,
              gte(toolUses.day, since),
            ),
          )
          .all(),
      offsets: async () =>
        new Map(
          db
            .select()
            .from(transcripts)
            .all()
            .map((row) => [row.path, row.offset]),
        ),
    },
  };
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function migrate(sqlite: Database.Database, db: Db, file: string, migrations: readonly Migration[]): void {
  db.run(sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT`);
  const known = migrations.at(-1)?.version ?? 0;

  // Immediate, so a second process opening the same file waits, then finds the work done.
  sqlite
    .transaction(() => {
      const current = schemaVersion(db);
      if (current > known) {
        throw new StoreError(
          `${file} has schema version ${current}, newer than this build of grenier knows (${known}). Update grenier.`,
        );
      }
      for (const migration of migrations) {
        if (migration.version <= current) continue;
        sqlite.exec(migration.sql);
        db.run(
          sql`INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, ${migration.name}, ${Date.now()})`,
        );
      }
    })
    .immediate();
}

function schemaVersion(db: Db): number {
  const row = db.get<{ version: number | null }>(sql`SELECT max(version) AS version FROM schema_migrations`);
  return row.version ?? 0;
}
