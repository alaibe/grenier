import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Migration, migrations, StoreError, schema } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import Database from "better-sqlite3";
import { eq, is, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LATEST = migrations.at(-1)?.version ?? 0;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grenier-store-"));
  file = join(dir, "grenier.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inspect<T>(read: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function tableNames(): string[] {
  return inspect((db) =>
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
}

describe("openSqliteStore", () => {
  it("creates a new database at the latest schema version", async () => {
    const store = openSqliteStore(file);
    expect(await store.schemaVersion()).toBe(LATEST);
    await store.close();

    expect(tableNames()).toEqual(
      expect.arrayContaining([
        "answer_sources",
        "answers",
        "answers_fts",
        "budgets",
        "clients",
        "events",
        "file_summaries",
        "schema_migrations",
        "sessions",
        "usage",
      ]),
    );
  });

  it("makes the database file readable by this user only", async () => {
    await openSqliteStore(file).close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("applies each migration once across reopenings", async () => {
    await openSqliteStore(file).close();
    const store = openSqliteStore(file);
    expect(await store.schemaVersion()).toBe(LATEST);
    await store.close();
    expect(inspect((db) => db.prepare("SELECT count(*) AS n FROM schema_migrations").get())).toEqual({
      n: migrations.length,
    });
  });

  it("applies only the migrations a database is missing", async () => {
    const first: Migration = { version: 1, name: "0001_a", sql: "CREATE TABLE a (x INTEGER) STRICT;" };
    const second: Migration = { version: 2, name: "0002_b", sql: "CREATE TABLE b (y INTEGER) STRICT;" };
    await openSqliteStore(file, { migrations: [first] }).close();

    const store = openSqliteStore(file, { migrations: [first, second] });
    expect(await store.schemaVersion()).toBe(2);
    await store.close();
    expect(tableNames()).toEqual(["a", "b", "schema_migrations"]);
  });

  it("applies nothing when a migration fails", () => {
    const good: Migration = { version: 1, name: "0001_a", sql: "CREATE TABLE a (x INTEGER) STRICT;" };
    const bad: Migration = { version: 2, name: "0002_bad", sql: "CREATE TABLE oops (" };
    expect(() => openSqliteStore(file, { migrations: [good, bad] })).toThrow();
    expect(tableNames()).toEqual(["schema_migrations"]);
  });

  it("refuses a database written by a newer build", async () => {
    await openSqliteStore(file).close();
    const older = migrations.slice(0, -1);
    expect(() => openSqliteStore(file, { migrations: older })).toThrow(StoreError);
    expect(() => openSqliteStore(file, { migrations: older })).toThrow(
      `has schema version ${LATEST}, newer than this build of grenier knows (${LATEST - 1})`,
    );
  });

  it("works in memory", async () => {
    const store = openSqliteStore(":memory:");
    expect(await store.schemaVersion()).toBe(LATEST);
    await store.close();
  });
});

describe("the schema", () => {
  function withDb(test: (db: BetterSQLite3Database<typeof schema>, sqlite: Database.Database) => void): void {
    const sqlite = new Database(file);
    sqlite.pragma("foreign_keys = ON");
    try {
      test(drizzle(sqlite, { schema }), sqlite);
    } finally {
      sqlite.close();
    }
  }

  function addAnswer(db: BetterSQLite3Database<typeof schema>, id: string, question: string): void {
    db.insert(schema.answers)
      .values({ id, repoId: "repo", question, answer: "an answer", createdAt: 0, author: "local" })
      .run();
  }

  function search(db: BetterSQLite3Database<typeof schema>, query: string): string[] {
    return db
      .all<{ id: string }>(
        sql`SELECT answers.id FROM answers_fts JOIN answers ON answers.seq = answers_fts.rowid WHERE answers_fts MATCH ${query}`,
      )
      .map((row) => row.id);
  }

  it("matches schema.ts, column by column, once migrated", async () => {
    await openSqliteStore(file).close();
    withDb((_, sqlite) => {
      const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        const config = getTableConfig(table);
        const columns = sqlite.pragma(`table_info(${config.name})`) as {
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }[];
        const actual = columns.map((column) => ({
          name: column.name,
          type: column.type.toLowerCase(),
          notNull: column.notnull === 1 || column.pk > 0,
        }));
        const expected = config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType().toLowerCase(),
          notNull: column.notNull || column.primary,
        }));
        expect(actual, config.name).toEqual(expect.arrayContaining(expected));
        expect(actual, config.name).toHaveLength(expected.length);
      }
    });
  });

  it("keeps the full-text index in step with the answers", async () => {
    await openSqliteStore(file).close();
    withDb((db, sqlite) => {
      addAnswer(db, "a1", "How does the proxy stream responses?");
      addAnswer(db, "a2", "Where are budgets enforced?");
      expect(search(db, "proxy")).toEqual(["a1"]);

      db.update(schema.answers).set({ question: "How is the cache keyed?" }).where(eq(schema.answers.id, "a1")).run();
      expect(search(db, "proxy")).toEqual([]);
      expect(search(db, "cache")).toEqual(["a1"]);

      db.update(schema.answers)
        .set({ hits: sql`${schema.answers.hits} + 1` })
        .where(eq(schema.answers.id, "a2"))
        .run();
      expect(search(db, "budgets")).toEqual(["a2"]);

      db.delete(schema.answers).where(eq(schema.answers.id, "a2")).run();
      expect(search(db, "budgets")).toEqual([]);
      expect(() => sqlite.exec("INSERT INTO answers_fts (answers_fts) VALUES ('integrity-check')")).not.toThrow();
    });
  });

  it("removes an answer's sources with the answer", async () => {
    await openSqliteStore(file).close();
    withDb((db) => {
      addAnswer(db, "a1", "question");
      db.insert(schema.answerSources).values({ answerId: "a1", path: "src/x.ts", blobHash: "abc" }).run();
      db.delete(schema.answers).where(eq(schema.answers.id, "a1")).run();
      expect(db.select().from(schema.answerSources).all()).toEqual([]);
    });
  });

  it("refuses a source for an answer that does not exist", async () => {
    await openSqliteStore(file).close();
    withDb((db) => {
      expect(() =>
        db.insert(schema.answerSources).values({ answerId: "nope", path: "src/x.ts", blobHash: "abc" }).run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  it("stores a client's scopes as a JSON list", async () => {
    await openSqliteStore(file).close();
    withDb((db) => {
      db.insert(schema.clients).values({ id: "c1", name: "cursor", tokenHash: "h", createdAt: 0 }).run();
      expect(db.select({ scopes: schema.clients.scopes }).from(schema.clients).get()).toEqual({ scopes: [] });
    });
  });
});
