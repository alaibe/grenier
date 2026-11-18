import type {
  Answer,
  AnswerSource,
  AuditEntry,
  Budget,
  Client,
  Event,
  FileSummary,
  Item,
  NewAnswer,
  NewEvent,
  NewFileSummary,
  NewItem,
  NewSession,
  NewSource,
  NewStep,
  NewUsage,
  ReviewEntry,
  Session,
  Source,
  Step,
  TeamRepo,
  Usage,
} from "./schema.ts";

/** Every package reads and writes through this interface; adapters exist for local SQLite and, later, Cloudflare D1. */
export interface Store {
  /** The version of the newest migration applied to this database. */
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
  sessions: SessionStore;
  usage: UsageStore;
  events: EventStore;
  steps: StepStore;
  budgets: BudgetStore;
  answers: AnswerStore;
  summaries: SummaryStore;
  clients: ClientStore;
  team: TeamStore;
  sources: SourceStore;
  items: ItemStore;
  audit: AuditStore;
  review: ReviewStore;
}

export interface SessionStore {
  /** Adds a session; one that already exists is left as it is. */
  create(session: NewSession): Promise<void>;
  get(id: string): Promise<Session | undefined>;
  end(id: string, endedAt: number): Promise<void>;
  setPaused(id: string, paused: boolean): Promise<void>;
  list(filter?: { since?: number }): Promise<Session[]>;
  /** The sessions the loop guard paused, oldest first. */
  paused(): Promise<Session[]>;
}

export interface UsageWithSession extends Usage {
  repoRoot: string | null;
  repoId: string | null;
}

export interface SpendFilter {
  /** Unix milliseconds, inclusive. */
  since?: number;
  sessionId?: string;
  repoId?: string;
}

export interface UsageStore {
  add(row: NewUsage): Promise<void>;
  /** The sum of `cost` over the matching rows. */
  spend(filter: SpendFilter): Promise<number>;
  /** Rows with their session's repository, oldest first. */
  list(filter?: { since?: number; sessionId?: string }): Promise<UsageWithSession[]>;
  /** Rows with an id above `id`, in order, at most `limit`. */
  after(id: number, limit: number): Promise<Usage[]>;
  /** What the session's latest request cost, or null before its first. */
  lastCost(sessionId: string): Promise<number | null>;
  /** Removes the rows older than `before`; returns how many. */
  prune(before: number): Promise<number>;
}

export interface EventStore {
  add(event: NewEvent): Promise<void>;
  list(filter?: { sessionId?: string; kind?: string; since?: number }): Promise<Event[]>;
  /** Removes the events older than `before`; returns how many. */
  prune(before: number): Promise<number>;
}

export interface StepSummary {
  sessionId: string;
  steps: number;
  files: number;
  first: number;
  last: number;
  /** Questions to the exploration cache, and how many it answered with a hit. */
  asks: number;
  hits: number;
  /** Reads before the session's first question to the cache: all of its reads when it never asked. */
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

export type BudgetScope = "daily" | "session" | "repo";

export interface BudgetStore {
  /** Sets one limit. `key` is "" for daily and session limits, the repository's name for a repo limit. */
  set(scope: BudgetScope, key: string, limit: number): Promise<void>;
  remove(scope: BudgetScope, key: string): Promise<void>;
  list(): Promise<Budget[]>;
}

export interface AnswerWithSources extends Answer {
  sources: Pick<AnswerSource, "path" | "blobHash">[];
}

export interface AnswerStore {
  /**
   * Adds an answer with the blob hash of every file it was worked out from, and its question's vector. An earlier
   * answer to the same question in the same repository (ignoring case and surrounding space) is replaced.
   */
  add(
    answer: NewAnswer,
    sources: readonly { path: string; blobHash: string }[],
    embedding?: { model: string; vector: Float32Array },
  ): Promise<void>;
  get(id: string): Promise<AnswerWithSources | undefined>;
  /** Full-text matches for any of the terms in a repository's answers, best first (BM25). */
  search(repoId: string, terms: readonly string[], limit: number): Promise<{ id: string; score: number }[]>;
  /** Every question vector of a repository made by `model`. */
  vectors(repoId: string, model: string): Promise<{ id: string; vector: Float32Array }[]>;
  /** Counts one more reuse. */
  hit(id: string): Promise<void>;
  /** Reuses counted over every answer. */
  totalHits(): Promise<number>;
  /** A repository's answers, newest first. */
  list(repoId: string): Promise<AnswerWithSources[]>;
  /** Answers of these repositories not yet on the team server, oldest first, without those it refused. */
  unshared(repoIds: readonly string[], limit: number): Promise<AnswerWithSources[]>;
  markShared(ids: readonly string[]): Promise<void>;
  /** Keeps why the team server refused an answer, so sync passes over it. */
  refuse(id: string, reason: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Removes the answers of one repository, or all; returns how many. */
  clear(repoId?: string): Promise<number>;
  stats(): Promise<{ repoId: string; answers: number; hits: number }[]>;
}

export interface SummaryStore {
  put(summary: NewFileSummary): Promise<void>;
  get(repoId: string, path: string, blobHash: string): Promise<FileSummary | undefined>;
  /** The newest summary of each path in a repository. */
  latest(repoId: string): Promise<FileSummary[]>;
  /** Summaries of these repositories not yet on the team server, oldest first, without those it refused. */
  unshared(repoIds: readonly string[], limit: number): Promise<FileSummary[]>;
  markShared(keys: readonly { repoId: string; path: string; blobHash: string }[]): Promise<void>;
  refuse(key: { repoId: string; path: string; blobHash: string }, reason: string): Promise<void>;
  clear(repoId?: string): Promise<number>;
  stats(): Promise<{ repoId: string; summaries: number }[]>;
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

export interface TeamStore {
  repos(): Promise<TeamRepo[]>;
  share(repoId: string, root: string, at: number): Promise<void>;
  unshare(repoId: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface SourceStore {
  add(source: NewSource): Promise<void>;
  list(): Promise<Source[]>;
  get(name: string): Promise<Source | undefined>;
  /** Removes the source and every item it brought. */
  remove(name: string): Promise<boolean>;
  saveState(id: string, state: Record<string, unknown>, at: number): Promise<void>;
  /** Puts the source in the vault or takes it out; false when there is no source of that name. */
  setVault(name: string, on: boolean): Promise<boolean>;
}

export interface ItemFilter {
  /** Only items of these sources: what the reading client's scope allows. */
  sourceIds: readonly string[];
  from?: number;
  to?: number;
}

export interface ItemStore {
  /** Adds or replaces an item; false when it was already there with the same content hash. */
  put(item: NewItem): Promise<boolean>;
  get(id: string): Promise<Item | undefined>;
  /** Removes these items; returns how many there were. */
  remove(ids: readonly string[]): Promise<number>;
  /** Removes the items of a source whose ids are not in `keep`; returns how many. */
  prune(sourceId: string, keep: ReadonlySet<string>): Promise<number>;
  ids(sourceId: string): Promise<string[]>;
  /** Full-text matches for any of the terms, best first (BM25). */
  search(terms: readonly string[], filter: ItemFilter, limit: number): Promise<Item[]>;
  /** Items in time order, optionally matching any of the terms. */
  timeline(terms: readonly string[], filter: ItemFilter, limit: number): Promise<Item[]>;
  /** Items whose people include `name` (case-insensitive), newest first. */
  withPerson(name: string, filter: ItemFilter, limit: number): Promise<Item[]>;
  count(): Promise<{ sourceId: string; items: number }[]>;
}

export interface AuditStore {
  add(entry: {
    ts: number;
    clientId: string;
    tool: string;
    args: Record<string, unknown>;
    itemIds: string[];
  }): Promise<void>;
  list(filter?: { clientId?: string; since?: number; limit?: number }): Promise<AuditEntry[]>;
}

export interface ReviewStore {
  add(entry: { id: string; clientId: string; text: string; tags: string[]; ts: number }): Promise<void>;
  get(id: string): Promise<ReviewEntry | undefined>;
  list(state?: ReviewEntry["state"]): Promise<ReviewEntry[]>;
  decide(id: string, state: "approved" | "rejected", at: number): Promise<boolean>;
}
