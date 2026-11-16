import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrations as allMigrations, type Migration, type Store, StoreError } from "./index.ts";
import * as schema from "./schema.ts";

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

  return {
    schemaVersion: async () => schemaVersion(db),
    close: async () => {
      sqlite.close();
    },
  };
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
