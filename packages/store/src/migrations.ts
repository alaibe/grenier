import init from "../migrations/0001_init.sql";

export interface Migration {
  version: number;
  /** The SQL file's name without its extension. */
  name: string;
  sql: string;
}

/** In order. A shipped migration never changes; a schema change is a new file listed here. */
export const migrations: readonly Migration[] = [{ version: 1, name: "0001_init", sql: init }];
