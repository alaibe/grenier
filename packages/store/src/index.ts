export { type Migration, migrations } from "./migrations.ts";
export type {
  Answer,
  AnswerSource,
  Budget,
  Client,
  Event,
  FileSummary,
  NewAnswer,
  NewEvent,
  NewSession,
  NewUsage,
  Session,
  Usage,
} from "./schema.ts";
export * as schema from "./schema.ts";
export type {
  AnswerStore,
  AnswerWithSources,
  BudgetScope,
  BudgetStore,
  ClientStore,
  EventStore,
  SessionStore,
  SpendFilter,
  Store,
  SummaryStore,
  UsageStore,
  UsageWithSession,
} from "./store.ts";

export class StoreError extends Error {
  override name = "StoreError";
}
