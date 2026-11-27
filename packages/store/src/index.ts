export { type Migration, migrations } from "./migrations.ts";
export type {
  Anchor,
  Approval,
  Client,
  Event,
  HistoryEntry,
  KnownRepo,
  Link,
  NewEvent,
  NewSession,
  NewUsage,
  OutboxEntry,
  RecordRow,
  Run,
  Session,
  ToolUse,
  Usage,
} from "./schema.ts";
export * as schema from "./schema.ts";
export type {
  ApprovalStore,
  ClientStore,
  EventStore,
  FullRecord,
  HistoryStore,
  OutboxStore,
  RecordFilter,
  RecordInput,
  RecordStore,
  RepoStore,
  RunStore,
  SessionStore,
  StateStore,
  Store,
  ToolUseStore,
  UsageStore,
  UsageWithSession,
} from "./store.ts";

export { toInput } from "./store.ts";

export class StoreError extends Error {
  override name = "StoreError";
}
