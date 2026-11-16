import type { Budget, Event, NewEvent, NewSession, NewUsage, Session, Usage } from "./schema.ts";

/** Every package reads and writes through this interface; adapters exist for local SQLite and, later, Cloudflare D1. */
export interface Store {
  /** The version of the newest migration applied to this database. */
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
  sessions: SessionStore;
  usage: UsageStore;
  events: EventStore;
  budgets: BudgetStore;
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
