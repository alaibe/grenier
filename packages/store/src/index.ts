export { type Migration, migrations } from "./migrations.ts";
export type {
  Anchor,
  Approval,
  AuditEntry,
  Client,
  Event,
  HistoryEntry,
  Link,
  NewEvent,
  NewSession,
  NewStep,
  NewUsage,
  OutboxEntry,
  Outcome,
  RecordRow,
  Run,
  Session,
  Space,
  Step,
  Usage,
} from "./schema.ts";
export * as schema from "./schema.ts";
export type {
  ApprovalStore,
  AuditStore,
  ClientStore,
  EventStore,
  FullRecord,
  HistoryStore,
  OutboxStore,
  OutcomeStore,
  RecordFilter,
  RecordInput,
  RecordStore,
  RunStore,
  SessionStore,
  SpaceStore,
  StateStore,
  StepStore,
  StepSummary,
  Store,
  UsageStore,
  UsageWithSession,
} from "./store.ts";

export class StoreError extends Error {
  override name = "StoreError";
}
