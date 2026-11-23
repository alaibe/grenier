import type {
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

/** Every package reads and writes through this interface. */
export interface Store {
  /** The version of the newest migration applied to this database. */
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
  sessions: SessionStore;
  usage: UsageStore;
  events: EventStore;
  steps: StepStore;
  state: StateStore;
  spaces: SpaceStore;
  records: RecordStore;
  history: HistoryStore;
  outbox: OutboxStore;
  approvals: ApprovalStore;
  runs: RunStore;
  outcomes: OutcomeStore;
  clients: ClientStore;
  audit: AuditStore;
}

export interface SessionStore {
  /** Adds a session; one that already exists is left as it is. */
  create(session: NewSession): Promise<void>;
  get(id: string): Promise<Session | undefined>;
  end(id: string, endedAt: number): Promise<void>;
  setPaused(id: string, paused: boolean): Promise<void>;
  list(): Promise<Session[]>;
  /** The sessions the loop guard paused, oldest first. */
  paused(): Promise<Session[]>;
}

export interface UsageWithSession extends Usage {
  repoRoot: string | null;
  repoId: string | null;
  cwd: string | null;
  client: string | null;
  startedAt: number | null;
}

export interface UsageStore {
  add(row: NewUsage): Promise<void>;
  /** Rows with their session's repository, oldest first. */
  list(filter?: { since?: number; sessionId?: string }): Promise<UsageWithSession[]>;
  /** Removes the rows older than `before`; returns how many. */
  prune(before: number): Promise<number>;
}

export interface EventStore {
  add(event: NewEvent): Promise<void>;
  list(filter?: { kind?: string }): Promise<Event[]>;
  /** Removes the events older than `before`; returns how many. */
  prune(before: number): Promise<number>;
}

export interface StepSummary {
  sessionId: string;
  steps: number;
  files: number;
  first: number;
  last: number;
  /** Questions to the store, and how many it answered with a hit. */
  asks: number;
  hits: number;
  /** Reads before the session's first question to the store: all of its reads when it never asked. */
  readsBeforeAsk: number;
}

export interface StepStore {
  /** Adds steps; one already recorded for the same call and part is left as it is. */
  add(rows: readonly NewStep[]): Promise<void>;
  /** A session's steps in the order they were taken. */
  list(sessionId: string): Promise<Step[]>;
  /** The sessions with steps since `since`, newest first, with how many steps and distinct files each has. */
  sessions(since: number): Promise<StepSummary[]>;
  /** Removes the steps older than `before`; returns how many. */
  prune(before: number): Promise<number>;
}

export interface StateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface SpaceStore {
  /** Adds the space, or updates its name and root. */
  put(space: Space): Promise<void>;
  get(id: string): Promise<Space | undefined>;
  list(): Promise<Space[]>;
  /** Removes the space and every record in it, here. */
  remove(id: string): Promise<void>;
}

/** A record with what it was worked out from and what it points at. */
export interface FullRecord extends RecordRow {
  anchors: Pick<Anchor, "kind" | "repoId" | "ref" | "version">[];
  links: Pick<Link, "kind" | "ref">[];
}

export type RecordInput = Omit<RecordRow, "seq" | "hits"> & {
  anchors: FullRecord["anchors"];
  links: FullRecord["links"];
};

export interface RecordFilter {
  /** Only records of these spaces. */
  spaces: readonly string[];
  type?: string;
  kind?: string;
  /** Records linking to this ref, as `kind:ref` would: a record id, a person, a repository. */
  linkedTo?: { kind: Link["kind"]; ref: string };
  /** With the retired ones too. */
  retired?: boolean;
  limit?: number;
}

export interface RecordStore {
  /**
   * Adds or replaces the record with its anchors, links and vector. Its hit count stays. When `embedding` is not
   * given, the vector it had stays only if its title and body did not change.
   */
  put(record: RecordInput, embedding?: { model: string; vector: Float32Array }): Promise<void>;
  get(id: string): Promise<FullRecord | undefined>;
  /** Newest first. */
  list(filter: RecordFilter): Promise<FullRecord[]>;
  /** Full-text matches for any of the terms, best first (BM25), among records not retired. */
  search(terms: readonly string[], spaces: readonly string[], limit: number): Promise<{ id: string; score: number }[]>;
  /** Every vector of these spaces' records made by `model`, without the retired ones. */
  vectors(spaces: readonly string[], model: string): Promise<{ id: string; vector: Float32Array }[]>;
  /** Counts one more reuse. */
  hit(id: string): Promise<void>;
  /** The number the team store gave the record, once it took it. */
  setVersion(id: string, version: number): Promise<void>;
  /** Records and reuses, by space and type, without the retired ones. */
  stats(): Promise<{ space: string; type: string; records: number; hits: number }[]>;
}

export interface HistoryStore {
  /** Keeps a version; one already kept for the same record and version is left as it is. */
  add(entry: Omit<HistoryEntry, "id">): Promise<void>;
  /** Oldest first. */
  list(recordId: string): Promise<HistoryEntry[]>;
}

export interface OutboxStore {
  add(entry: Omit<OutboxEntry, "seq" | "refused">): Promise<void>;
  /** The oldest first, without those the team store refused, and without `me` ones when `withoutMe`. */
  pending(limit: number, withoutMe?: boolean): Promise<OutboxEntry[]>;
  /** Every entry still here, refused ones included. */
  list(): Promise<OutboxEntry[]>;
  remove(ids: readonly string[]): Promise<void>;
  refuse(id: string, reason: string): Promise<void>;
}

export interface ApprovalStore {
  get(recordId: string, kind: Approval["kind"]): Promise<Approval | undefined>;
  list(kind?: Approval["kind"]): Promise<Approval[]>;
  put(approval: Approval): Promise<void>;
  remove(recordId: string, kind: Approval["kind"]): Promise<void>;
}

export interface RunStore {
  add(run: Run): Promise<void>;
  update(id: string, change: Partial<Omit<Run, "id">>): Promise<void>;
  /** Newest first. */
  list(filter?: { routineId?: string; since?: number; limit?: number }): Promise<Run[]>;
}

export interface OutcomeStore {
  put(outcome: Outcome): Promise<void>;
  list(): Promise<Outcome[]>;
}

export interface ClientStore {
  add(client: { id: string; name: string; tokenHash: string; scopes: string[]; createdAt: number }): Promise<void>;
  /** The client holding this token, unless it was revoked. */
  findActive(tokenHash: string): Promise<Client | undefined>;
  list(): Promise<Client[]>;
  /**
   * Revokes the named client; false when there is no such active client. The revoked entry keeps its id (the audit
   * log refers to it) but takes the name `<name>~<time>`, so the name can be given to a new client.
   */
  revoke(name: string, at: number): Promise<boolean>;
}

export interface AuditStore {
  add(entry: {
    ts: number;
    clientId: string;
    tool: string;
    args: Record<string, unknown>;
    recordIds: string[];
  }): Promise<void>;
  list(filter?: { clientId?: string; since?: number; limit?: number }): Promise<AuditEntry[]>;
}
