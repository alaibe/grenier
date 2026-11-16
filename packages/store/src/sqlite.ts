import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import { migrations as allMigrations, type Migration, type Store, StoreError } from "./index.ts";

export interface SqliteStoreOptions {
  /** The migrations to apply. Tests pass their own; everything else uses the shipped ones. */
  migrations?: readonly Migration[];
}

/** Opens (or creates, readable by this user only) the database at `file` and brings its schema up to date. */
export function openSqliteStore(file: string, options: SqliteStoreOptions = {}): Store {
  if (file !== ":memory:") closeSync(openSync(file, "a", 0o600));

  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db, file, options.migrations ?? allMigrations);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    schemaVersion: async () => schemaVersion(db),
    close: async () => {
      db.close();
    },
  };
}

function migrate(db: Database.Database, file: string, migrations: readonly Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT`);
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  const known = migrations.at(-1)?.version ?? 0;

  // Immediate, so a second process opening the same file waits, then finds the work done.
  db.transaction(() => {
    const current = schemaVersion(db);
    if (current > known) {
      throw new StoreError(
        `${file} has schema version ${current}, newer than this build of grenier knows (${known}). Update grenier.`,
      );
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    }
  }).immediate();
}

function schemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number | null };
  return row.version ?? 0;
}
