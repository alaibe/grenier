import init from "../migrations/0000_init.sql";
import answersFts from "../migrations/0001_answers_fts.sql";
import answerEmbeddings from "../migrations/0002_answer_embeddings.sql";
import answersFtsPorter from "../migrations/0003_answers_fts_porter.sql";
import teamSync from "../migrations/0004_team_sync.sql";
import personalData from "../migrations/0005_personal_data.sql";
import itemsFts from "../migrations/0006_items_fts.sql";

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
  { version: 3, name: "0002_answer_embeddings", sql: answerEmbeddings },
  { version: 4, name: "0003_answers_fts_porter", sql: answersFtsPorter },
  { version: 5, name: "0004_team_sync", sql: teamSync },
  { version: 6, name: "0005_personal_data", sql: personalData },
  { version: 7, name: "0006_items_fts", sql: itemsFts },
];
