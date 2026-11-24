import init from "../migrations/0000_init.sql";
import recordsFts from "../migrations/0001_records_fts.sql";
import noTraces from "../migrations/0002_no_traces.sql";
import folders from "../migrations/0003_folders.sql";

export interface Migration {
  /** 1 for the first migration: the schema version a database has once it is applied. */
  version: number;
  name: string;
  sql: string;
}

/** In the order of migrations/meta/_journal.json; a shipped migration never changes. */
export const migrations: readonly Migration[] = [
  { version: 1, name: "0000_init", sql: init },
  { version: 2, name: "0001_records_fts", sql: recordsFts },
  { version: 3, name: "0002_no_traces", sql: noTraces },
  { version: 4, name: "0003_folders", sql: folders },
];
