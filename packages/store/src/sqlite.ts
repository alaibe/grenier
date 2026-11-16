import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, notInArray, type SQL, sql, sum } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrations as allMigrations, type Migration, StoreError } from "./index.ts";
import * as schema from "./schema.ts";
import type { BudgetScope, ItemFilter, SpendFilter, Store } from "./store.ts";

type Db = BetterSQLite3Database<typeof schema>;

export interface SqliteStoreOptions {
  /** The migrations to apply. Tests pass their own; everything else uses the shipped ones. */
  migrations?: readonly Migration[];
}

/** Opens (or creates, readable by this user only) the database at `file` and brings its schema up to date. */
export function openSqliteStore(file: string, options: SqliteStoreOptions = {}): Store {
  if (file !== ":memory:") closeSync(openSync(file, "a", 0o600));

  const sqlite = new Database(file);
  const db = drizzle(sqlite, { schema });
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    migrate(sqlite, db, file, options.migrations ?? allMigrations);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const {
    sessions,
    usage,
    events,
    budgets,
    answers,
    answerSources,
    answerEmbeddings,
    fileSummaries,
    clients,
    teamRepos,
    syncState,
    sources,
    items,
    audit,
    reviewQueue,
  } = schema;

  const itemConditions = (filter: ItemFilter) =>
    and(
      filter.sourceIds.length === 0 ? sql`0` : inArray(items.sourceId, [...filter.sourceIds]),
      filter.from === undefined ? undefined : gte(items.ts, filter.from),
      filter.to === undefined ? undefined : lte(items.ts, filter.to),
    );
  const ftsQuery = (terms: readonly string[]) =>
    terms
      .filter((term) => term.trim() !== "")
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(" OR ");

  return {
    schemaVersion: async () => schemaVersion(db),
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
      list: async (filter = {}) =>
        db
          .select()
          .from(sessions)
          .where(filter.since === undefined ? undefined : gte(sessions.startedAt, filter.since))
          .orderBy(asc(sessions.startedAt))
          .all(),
    },

    usage: {
      add: async (row) => {
        db.insert(usage).values(row).run();
      },
      spend: async (filter) => {
        const row = db
          .select({ total: sql<number | null>`sum(${usage.cost})` })
          .from(usage)
          .leftJoin(sessions, eq(sessions.id, usage.sessionId))
          .where(spendConditions(filter))
          .get();
        return row?.total ?? 0;
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
      after: async (id, limit) =>
        db.select().from(usage).where(gt(usage.id, id)).orderBy(asc(usage.id)).limit(limit).all(),
    },

    events: {
      add: async (event) => {
        db.insert(events).values(event).run();
      },
      list: async (filter = {}) =>
        db
          .select()
          .from(events)
          .where(
            and(
              filter.sessionId === undefined ? undefined : eq(events.sessionId, filter.sessionId),
              filter.kind === undefined ? undefined : eq(events.kind, filter.kind),
              filter.since === undefined ? undefined : gte(events.ts, filter.since),
            ),
          )
          .orderBy(asc(events.ts), asc(events.id))
          .all(),
    },

    budgets: {
      set: async (scope, key, limit) => {
        db.insert(budgets)
          .values({ scope, key, period: periodOf(scope), limitAmount: limit })
          .onConflictDoUpdate({
            target: [budgets.scope, budgets.key, budgets.period],
            set: { limitAmount: limit },
          })
          .run();
      },
      remove: async (scope, key) => {
        db.delete(budgets)
          .where(and(eq(budgets.scope, scope), eq(budgets.key, key), eq(budgets.period, periodOf(scope))))
          .run();
      },
      list: async () => db.select().from(budgets).orderBy(asc(budgets.scope), asc(budgets.key)).all(),
    },

    answers: {
      add: async (answer, sources, embedding) => {
        sqlite
          .transaction(() => {
            db.delete(answers)
              .where(
                and(
                  eq(answers.repoId, answer.repoId),
                  sql`lower(trim(${answers.question})) = lower(trim(${answer.question}))`,
                ),
              )
              .run();
            db.insert(answers).values(answer).run();
            if (sources.length > 0) {
              db.insert(answerSources)
                .values(
                  sources.map((source) => ({ answerId: answer.id, path: source.path, blobHash: source.blobHash })),
                )
                .run();
            }
            if (embedding) {
              db.insert(answerEmbeddings)
                .values({ answerId: answer.id, model: embedding.model, vector: toBlob(embedding.vector) })
                .run();
            }
          })
          .immediate();
      },
      get: async (id) => {
        const answer = db.select().from(answers).where(eq(answers.id, id)).get();
        if (!answer) return undefined;
        const sources = db
          .select({ path: answerSources.path, blobHash: answerSources.blobHash })
          .from(answerSources)
          .where(eq(answerSources.answerId, id))
          .orderBy(asc(answerSources.path))
          .all();
        return { ...answer, sources };
      },
      search: async (repoId, terms, limit) => {
        const query = terms
          .filter((term) => term.trim() !== "")
          .map((term) => `"${term.replace(/"/g, '""')}"`)
          .join(" OR ");
        if (query === "") return [];
        return db.all<{ id: string; score: number }>(sql`
          SELECT ${answers.id} AS id, bm25(answers_fts) AS score
          FROM answers_fts JOIN ${answers} ON ${answers.seq} = answers_fts.rowid
          WHERE answers_fts MATCH ${query} AND ${answers.repoId} = ${repoId}
          ORDER BY score LIMIT ${limit}`);
      },
      vectors: async (repoId, model) =>
        db
          .select({ id: answerEmbeddings.answerId, vector: answerEmbeddings.vector })
          .from(answerEmbeddings)
          .innerJoin(answers, eq(answers.id, answerEmbeddings.answerId))
          .where(and(eq(answers.repoId, repoId), eq(answerEmbeddings.model, model)))
          .all()
          .map((row) => ({ id: row.id, vector: fromBlob(row.vector) })),
      hit: async (id) => {
        db.update(answers)
          .set({ hits: sql`${answers.hits} + 1` })
          .where(eq(answers.id, id))
          .run();
      },
      totalHits: async () =>
        Number(
          db
            .select({ total: sql<number>`coalesce(sum(${answers.hits}), 0)` })
            .from(answers)
            .get()?.total ?? 0,
        ),
      unshared: async (repoIds, limit) => {
        if (repoIds.length === 0) return [];
        const rows = db
          .select()
          .from(answers)
          .where(and(inArray(answers.repoId, [...repoIds]), eq(answers.shared, false)))
          .orderBy(asc(answers.createdAt))
          .limit(limit)
          .all();
        return rows.map((answer) => ({
          ...answer,
          sources: db
            .select({ path: answerSources.path, blobHash: answerSources.blobHash })
            .from(answerSources)
            .where(eq(answerSources.answerId, answer.id))
            .orderBy(asc(answerSources.path))
            .all(),
        }));
      },
      markShared: async (ids) => {
        if (ids.length > 0)
          db.update(answers)
            .set({ shared: true })
            .where(inArray(answers.id, [...ids]))
            .run();
      },
      remove: async (id) => {
        db.delete(answers).where(eq(answers.id, id)).run();
      },
      clear: async (repoId) =>
        db
          .delete(answers)
          .where(repoId === undefined ? undefined : eq(answers.repoId, repoId))
          .run().changes,
      stats: async () =>
        db
          .select({ repoId: answers.repoId, answers: count(), hits: sql<number>`coalesce(${sum(answers.hits)}, 0)` })
          .from(answers)
          .groupBy(answers.repoId)
          .orderBy(asc(answers.repoId))
          .all()
          .map((row) => ({ ...row, hits: Number(row.hits) })),
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

    sources: {
      add: async (source) => {
        db.insert(sources).values(source).run();
      },
      list: async () => db.select().from(sources).orderBy(asc(sources.name)).all(),
      get: async (name) => db.select().from(sources).where(eq(sources.name, name)).get(),
      remove: async (name) => db.delete(sources).where(eq(sources.name, name)).run().changes > 0,
      saveState: async (id, state, at) => {
        db.update(sources).set({ state, lastSync: at }).where(eq(sources.id, id)).run();
      },
      setVault: async (name, on) =>
        db.update(sources).set({ vault: on }).where(eq(sources.name, name)).run().changes > 0,
    },

    items: {
      put: async (item) => {
        const existing = db.select({ contentHash: items.contentHash }).from(items).where(eq(items.id, item.id)).get();
        if (existing?.contentHash === item.contentHash) return false;
        const { seq: _seq, ...values } = item;
        db.insert(items).values(values).onConflictDoUpdate({ target: items.id, set: values }).run();
        return true;
      },
      get: async (id) => db.select().from(items).where(eq(items.id, id)).get(),
      remove: async (ids) =>
        ids.length === 0
          ? 0
          : db
              .delete(items)
              .where(inArray(items.id, [...ids]))
              .run().changes,
      prune: async (sourceId, keep) =>
        db
          .delete(items)
          .where(and(eq(items.sourceId, sourceId), keep.size === 0 ? undefined : notInArray(items.id, [...keep])))
          .run().changes,
      ids: async (sourceId) =>
        db
          .select({ id: items.id })
          .from(items)
          .where(eq(items.sourceId, sourceId))
          .all()
          .map((row) => row.id),
      search: async (terms, filter, limit) => {
        const query = ftsQuery(terms);
        if (query === "" || filter.sourceIds.length === 0) return [];
        return db
          .select({ item: items })
          .from(sql`items_fts`)
          .innerJoin(items, sql`${items.seq} = items_fts.rowid`)
          .where(and(sql`items_fts MATCH ${query}`, itemConditions(filter)))
          .orderBy(sql`bm25(items_fts)`)
          .limit(limit)
          .all()
          .map((row) => row.item);
      },
      timeline: async (terms, filter, limit) => {
        if (filter.sourceIds.length === 0) return [];
        const query = ftsQuery(terms);
        if (query === "") {
          return db.select().from(items).where(itemConditions(filter)).orderBy(asc(items.ts)).limit(limit).all();
        }
        return db
          .select({ item: items })
          .from(sql`items_fts`)
          .innerJoin(items, sql`${items.seq} = items_fts.rowid`)
          .where(and(sql`items_fts MATCH ${query}`, itemConditions(filter)))
          .orderBy(asc(items.ts))
          .limit(limit)
          .all()
          .map((row) => row.item);
      },
      withPerson: async (name, filter, limit) => {
        if (filter.sourceIds.length === 0 || name.trim() === "") return [];
        const pattern = `%${name
          .trim()
          .toLowerCase()
          .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        return db
          .select()
          .from(items)
          .where(and(sql`lower(${items.people}) LIKE ${pattern} ESCAPE '\\'`, itemConditions(filter)))
          .orderBy(desc(items.ts))
          .limit(limit)
          .all();
      },
      count: async () =>
        db
          .select({ sourceId: items.sourceId, items: count() })
          .from(items)
          .groupBy(items.sourceId)
          .orderBy(asc(items.sourceId))
          .all(),
    },

    audit: {
      add: async (entry) => {
        db.insert(audit).values(entry).run();
      },
      list: async (filter = {}) =>
        db
          .select()
          .from(audit)
          .where(
            and(
              filter.clientId === undefined ? undefined : eq(audit.clientId, filter.clientId),
              filter.since === undefined ? undefined : gte(audit.ts, filter.since),
            ),
          )
          .orderBy(desc(audit.ts), desc(audit.id))
          .limit(filter.limit ?? 1000)
          .all(),
    },

    review: {
      add: async (entry) => {
        db.insert(reviewQueue).values(entry).run();
      },
      get: async (id) => db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get(),
      list: async (state) =>
        db
          .select()
          .from(reviewQueue)
          .where(state === undefined ? undefined : eq(reviewQueue.state, state))
          .orderBy(asc(reviewQueue.ts))
          .all(),
      decide: async (id, state, at) =>
        db
          .update(reviewQueue)
          .set({ state, decidedAt: at })
          .where(and(eq(reviewQueue.id, id), eq(reviewQueue.state, "pending")))
          .run().changes > 0,
    },

    team: {
      repos: async () => db.select().from(teamRepos).orderBy(asc(teamRepos.root)).all(),
      share: async (repoId, root, at) => {
        db.insert(teamRepos)
          .values({ repoId, root, addedAt: at })
          .onConflictDoUpdate({ target: teamRepos.repoId, set: { root } })
          .run();
      },
      unshare: async (repoId) => db.delete(teamRepos).where(eq(teamRepos.repoId, repoId)).run().changes > 0,
      get: async (key) => db.select().from(syncState).where(eq(syncState.key, key)).get()?.value,
      set: async (key, value) => {
        db.insert(syncState).values({ key, value }).onConflictDoUpdate({ target: syncState.key, set: { value } }).run();
      },
    },

    summaries: {
      put: async (summary) => {
        db.insert(fileSummaries)
          .values(summary)
          .onConflictDoUpdate({
            target: [fileSummaries.repoId, fileSummaries.path, fileSummaries.blobHash],
            set: { summary: summary.summary, createdAt: summary.createdAt, shared: summary.shared ?? false },
          })
          .run();
      },
      get: async (repoId, path, blobHash) =>
        db
          .select()
          .from(fileSummaries)
          .where(
            and(eq(fileSummaries.repoId, repoId), eq(fileSummaries.path, path), eq(fileSummaries.blobHash, blobHash)),
          )
          .get(),
      latest: async (repoId) => {
        const rows = db
          .select()
          .from(fileSummaries)
          .where(eq(fileSummaries.repoId, repoId))
          .orderBy(asc(fileSummaries.path), desc(fileSummaries.createdAt))
          .all();
        const newest = new Map<string, (typeof rows)[number]>();
        for (const row of rows) if (!newest.has(row.path)) newest.set(row.path, row);
        return [...newest.values()];
      },
      unshared: async (repoIds, limit) =>
        repoIds.length === 0
          ? []
          : db
              .select()
              .from(fileSummaries)
              .where(and(inArray(fileSummaries.repoId, [...repoIds]), eq(fileSummaries.shared, false)))
              .orderBy(asc(fileSummaries.createdAt))
              .limit(limit)
              .all(),
      markShared: async (keys) => {
        for (const key of keys) {
          db.update(fileSummaries)
            .set({ shared: true })
            .where(
              and(
                eq(fileSummaries.repoId, key.repoId),
                eq(fileSummaries.path, key.path),
                eq(fileSummaries.blobHash, key.blobHash),
              ),
            )
            .run();
        }
      },
      clear: async (repoId) =>
        db
          .delete(fileSummaries)
          .where(repoId === undefined ? undefined : eq(fileSummaries.repoId, repoId))
          .run().changes,
      stats: async () =>
        db
          .select({ repoId: fileSummaries.repoId, summaries: count() })
          .from(fileSummaries)
          .groupBy(fileSummaries.repoId)
          .orderBy(asc(fileSummaries.repoId))
          .all(),
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

function periodOf(scope: BudgetScope): string {
  return scope === "session" ? "session" : "day";
}

function spendConditions(filter: SpendFilter): SQL | undefined {
  const { usage, sessions } = schema;
  return and(
    filter.since === undefined ? undefined : gte(usage.ts, filter.since),
    filter.sessionId === undefined ? undefined : eq(usage.sessionId, filter.sessionId),
    filter.repoId === undefined ? undefined : eq(sessions.repoId, filter.repoId),
  );
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
