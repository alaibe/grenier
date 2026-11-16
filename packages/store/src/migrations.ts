import init from "../migrations/0000_init.sql";
import answersFts from "../migrations/0001_answers_fts.sql";

export interface Migration {
  /** 1 for the first migration: the schema version a database has once it is applied. */
  version: number;
  /** drizzle-kit's tag, the SQL file's name without its extension. */
  name: string;
  sql: string;
}

/**
 * The files drizzle-kit wrote, in the order of migrations/meta/_journal.json. A shipped migration never changes; a
 * schema change is a new file (`pnpm db:generate`) listed here.
 */
export const migrations: readonly Migration[] = [
  { version: 1, name: "0000_init", sql: init },
  { version: 2, name: "0001_answers_fts", sql: answersFts },
];
