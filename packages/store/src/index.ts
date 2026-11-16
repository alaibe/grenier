export { type Migration, migrations } from "./migrations.ts";
export * as schema from "./schema.ts";

/** Every package reads and writes through this interface; adapters exist for local SQLite and, later, Cloudflare D1. */
export interface Store {
  /** The version of the newest migration applied to this database. */
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}

export class StoreError extends Error {
  override name = "StoreError";
}
