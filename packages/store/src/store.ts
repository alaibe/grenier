import type {
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

/** Every package reads and writes through this interface; adapters exist for local SQLite and, later, Cloudflare D1. */
export interface Store {
  /** The version of the newest migration applied to this database. */
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
  sessions: SessionStore;
  usage: UsageStore;
  events: EventStore;
  budgets: BudgetStore;
  answers: AnswerStore;
  summaries: SummaryStore;
  clients: ClientStore;
}

export interface SessionStore {
  /** Adds a session; one that already exists is left as it is. */
  create(session: NewSession): Promise<void>;
  get(id: string): Promise<Session | undefined>;
  end(id: string, endedAt: number): Promise<void>;
  setPaused(id: string, paused: boolean): Promise<void>;
  list(filter?: { since?: number }): Promise<Session[]>;
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
}

export interface EventStore {
  add(event: NewEvent): Promise<void>;
  list(filter?: { sessionId?: string; kind?: string; since?: number }): Promise<Event[]>;
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
  /** Removes the answers of one repository, or all; returns how many. */
  clear(repoId?: string): Promise<number>;
  stats(): Promise<{ repoId: string; answers: number; hits: number }[]>;
}

export interface SummaryStore {
  put(summary: FileSummary): Promise<void>;
  get(repoId: string, path: string, blobHash: string): Promise<FileSummary | undefined>;
  /** The newest summary of each path in a repository. */
  latest(repoId: string): Promise<FileSummary[]>;
  clear(repoId?: string): Promise<number>;
  stats(): Promise<{ repoId: string; summaries: number }[]>;
}

export interface ClientStore {
  add(client: { id: string; name: string; tokenHash: string; scopes: string[]; createdAt: number }): Promise<void>;
  /** The client holding this token, unless it was revoked. */
  findActive(tokenHash: string): Promise<Client | undefined>;
  list(): Promise<Client[]>;
  /** Revokes the named client; false when there is no such active client. */
  revoke(name: string, at: number): Promise<boolean>;
}
