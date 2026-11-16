export { type Migration, migrations } from "./migrations.ts";
export type {
  Answer,
  AnswerSource,
  Budget,
  Client,
  Event,
  FileSummary,
  NewEvent,
  NewSession,
  NewUsage,
  Session,
  Usage,
} from "./schema.ts";
export * as schema from "./schema.ts";
export type {
  BudgetScope,
  BudgetStore,
  EventStore,
  SessionStore,
  SpendFilter,
  Store,
  UsageStore,
  UsageWithSession,
} from "./store.ts";

export class StoreError extends Error {
  override name = "StoreError";
}
