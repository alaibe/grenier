import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SCHEMA_STEPS } from "../../../apps/server/src/schema.ts";

function store(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

const columns = (db: Database.Database, table: string) =>
  (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);

describe("the team store's schema steps", () => {
  it("take a store holding records and runs from the first version to the last, keeping what still means something", () => {
    const db = store();
    db.exec(SCHEMA_STEPS[0] as string);
    db.exec(`
      INSERT INTO devices (id, member_id, name, token_hash, created_at) VALUES ('d1', 'm1', 'ada-mbp', 'h', 1);
      INSERT INTO records (id, space, type, title, body, fields, author, created_at, updated_at, version, anchors, links)
        VALUES ('r1', 'team', 'Routine', 'Tidy', '', '{}', 'ada', 1, 1, 1, '[]', '[]');
      INSERT INTO runs (id, routine_id, device_id, version, kind, status, started_at, actions, cost, score, thumbs)
        VALUES ('run', 'r1', 'd1', 1, 'run', 'done', 1, 0, 0.5, NULL, 1),
               ('eval', 'r1', 'd1', 2, 'eval', 'done', 2, 0, 0.25, 1, NULL);
      INSERT INTO declines (task_id, device_id) VALUES ('t1', 'd1');
    `);
    for (const step of SCHEMA_STEPS.slice(1)) db.exec(step);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({
      value: String(SCHEMA_STEPS.length),
    });
    expect(db.prepare("SELECT id, top, folder FROM records").all()).toEqual([{ id: "r1", top: "team", folder: "" }]);
    expect(db.prepare("SELECT id FROM tops").all()).toEqual([{ id: "team" }]);
    expect(columns(db, "runs")).toEqual([
      "id",
      "routine_id",
      "task_id",
      "device_id",
      "status",
      "started_at",
      "ended_at",
      "actions",
      "cost",
    ]);
    expect(db.prepare("SELECT id, cost FROM runs").all()).toEqual([{ id: "run", cost: 0.5 }]);
    // A decline from before declines had a time counts as made long ago, so it no longer holds.
    expect(db.prepare("SELECT task_id, at FROM declines").all()).toEqual([{ task_id: "t1", at: 0 }]);
  });
});
