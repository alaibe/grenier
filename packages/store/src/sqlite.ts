import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import { and, asc, eq, gte, type SQL, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrations as allMigrations, type Migration, StoreError } from "./index.ts";
import * as schema from "./schema.ts";
import type { BudgetScope, SpendFilter, Store } from "./store.ts";

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

  const { sessions, usage, events, budgets } = schema;

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
  };
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
