import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Migration, migrations, StoreError } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import Database from "better-sqlite3";
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

describe("the initial schema", () => {
  function addAnswer(db: Database.Database, id: string, question: string): void {
    db.prepare(
      "INSERT INTO answers (id, repo_id, question, answer, created_at, author) VALUES (?, 'repo', ?, 'an answer', 0, 'local')",
    ).run(id, question);
  }

  function search(db: Database.Database, query: string): string[] {
    return (
      db
        .prepare(
          "SELECT answers.id FROM answers_fts JOIN answers ON answers.seq = answers_fts.rowid WHERE answers_fts MATCH ?",
        )
        .all(query) as { id: string }[]
    ).map((row) => row.id);
  }

  it("keeps the full-text index in step with the answers", async () => {
    await openSqliteStore(file).close();
    const db = new Database(file);
    try {
      addAnswer(db, "a1", "How does the proxy stream responses?");
      addAnswer(db, "a2", "Where are budgets enforced?");
      expect(search(db, "proxy")).toEqual(["a1"]);

      db.prepare("UPDATE answers SET question = 'How is the cache keyed?' WHERE id = 'a1'").run();
      expect(search(db, "proxy")).toEqual([]);
      expect(search(db, "cache")).toEqual(["a1"]);

      db.prepare("UPDATE answers SET hits = hits + 1 WHERE id = 'a2'").run();
      expect(search(db, "budgets")).toEqual(["a2"]);

      db.prepare("DELETE FROM answers WHERE id = 'a2'").run();
      expect(search(db, "budgets")).toEqual([]);
      expect(() => db.exec("INSERT INTO answers_fts (answers_fts) VALUES ('integrity-check')")).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("removes an answer's sources with the answer", async () => {
    await openSqliteStore(file).close();
    const db = new Database(file);
    db.pragma("foreign_keys = ON");
    try {
      addAnswer(db, "a1", "question");
      db.prepare("INSERT INTO answer_sources (answer_id, path, blob_hash) VALUES ('a1', 'src/x.ts', 'abc')").run();
      db.prepare("DELETE FROM answers WHERE id = 'a1'").run();
      expect(db.prepare("SELECT count(*) AS n FROM answer_sources").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("refuses a value of the wrong type", async () => {
    await openSqliteStore(file).close();
    const db = new Database(file);
    try {
      expect(() =>
        db.prepare("INSERT INTO usage (session_id, ts, input_tokens) VALUES ('s', 0, 'many')").run(),
      ).toThrow(/cannot store TEXT value in INTEGER column/);
    } finally {
      db.close();
    }
  });
});
