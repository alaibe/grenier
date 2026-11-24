import type {
  Anchor,
  Approval,
  Client,
  Event,
  HistoryEntry,
  Link,
  NewEvent,
  NewSession,
  NewUsage,
  OutboxEntry,
  RecordRow,
  Run,
  Session,
  Top,
  Usage,
} from "./schema.ts";

export interface Store {
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
  sessions: SessionStore;
  usage: UsageStore;
  events: EventStore;
  state: StateStore;
  tops: TopStore;
  records: RecordStore;
  history: HistoryStore;
  outbox: OutboxStore;
  approvals: ApprovalStore;
  runs: RunStore;
  clients: ClientStore;
}

export interface SessionStore {
  /** Adds a session; one that already exists is left as it is. */
  create(session: NewSession): Promise<void>;
  get(id: string): Promise<Session | undefined>;
  end(id: string, endedAt: number): Promise<void>;
  setPaused(id: string, paused: boolean): Promise<void>;
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
  prune(before: number): Promise<number>;
}

export interface EventStore {
  add(event: NewEvent): Promise<void>;
  list(filter?: { kind?: string }): Promise<Event[]>;
  prune(before: number): Promise<number>;
}

export interface StateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface TopStore {
  /** Adds the top folder, or updates its name and root. */
  put(top: Top): Promise<void>;
  get(id: string): Promise<Top | undefined>;
  list(): Promise<Top[]>;
}

export interface FullRecord extends RecordRow {
  anchors: Pick<Anchor, "kind" | "repoId" | "ref" | "version">[];
  links: Pick<Link, "kind" | "ref">[];
}

export type RecordInput = Omit<RecordRow, "seq" | "hits"> & {
  anchors: FullRecord["anchors"];
  links: FullRecord["links"];
};

export interface RecordFilter {
  tops: readonly string[];
  type?: string;
  kind?: string;
  /** Records linking to this ref, as `kind:ref` would: a record id, a person, a repository. */
  linkedTo?: { kind: Link["kind"]; ref: string };
  /** With the retired ones too. */
  retired?: boolean;
  limit?: number;
}

export interface RecordStore {
  /** Keeps the hit count; without `embedding`, the old vector stays only if title and body are unchanged. */
  put(record: RecordInput, embedding?: { model: string; vector: Float32Array }): Promise<void>;
  get(id: string): Promise<FullRecord | undefined>;
  /** Newest first. */
  list(filter: RecordFilter): Promise<FullRecord[]>;
  /** Full-text matches for any of the terms, best first (BM25), among records not retired. */
  search(terms: readonly string[], tops: readonly string[], limit: number): Promise<{ id: string; score: number }[]>;
  /** Every vector of these top folders' records made by `model`, without the retired ones. */
  vectors(tops: readonly string[], model: string): Promise<{ id: string; vector: Float32Array }[]>;
  hit(id: string): Promise<void>;
  /** The number the team store gave the record, once it took it. */
  setVersion(id: string, version: number): Promise<void>;
  /** Records and reuses, by top folder and type, without the retired ones. */
  stats(): Promise<{ top: string; type: string; records: number; hits: number }[]>;
}

export interface HistoryStore {
  /** Keeps a version; one already kept for the same record and version is left as it is. */
  add(entry: Omit<HistoryEntry, "id">): Promise<void>;
  /** Oldest first. */
  list(recordId: string): Promise<HistoryEntry[]>;
}

export interface OutboxStore {
  add(entry: Omit<OutboxEntry, "seq">): Promise<void>;
  /** The oldest first, without `me` ones when `withoutMe`. */
  pending(limit: number, withoutMe?: boolean): Promise<OutboxEntry[]>;
  list(): Promise<OutboxEntry[]>;
  remove(ids: readonly string[]): Promise<void>;
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

export interface ClientStore {
  add(client: { id: string; name: string; tokenHash: string; scopes: string[]; createdAt: number }): Promise<void>;
  /** The client holding this token, unless it was revoked. */
  findActive(tokenHash: string): Promise<Client | undefined>;
  list(): Promise<Client[]>;
  /** False when no such active client; the revoked one is renamed `<name>~<time>` so its name can be reused. */
  revoke(name: string, at: number): Promise<boolean>;
}
