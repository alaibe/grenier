import { blob, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Times are Unix milliseconds. Edit this file, then `pnpm db:generate` writes the migration.
// The full-text index on answers and its triggers are hand-written SQL in a custom migration, not modelled here.

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    client: text("client"),
    repoRoot: text("repo_root"),
    repoId: text("repo_id"),
    cwd: text("cwd"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("sessions_repo").on(table.repoId)],
);

export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    ts: integer("ts").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    outputTokens: integer("output_tokens"),
    cost: real("cost"),
    status: integer("status"),
  },
  (table) => [index("usage_session_ts").on(table.sessionId, table.ts), index("usage_ts").on(table.ts)],
);

/** Loop detected, budget hit, pause, resume. */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    ts: integer("ts").notNull(),
    kind: text("kind").notNull(),
    detail: text("detail"),
  },
  (table) => [index("events_session_ts").on(table.sessionId, table.ts)],
);

export const fileSummaries = sqliteTable(
  "file_summaries",
  {
    repoId: text("repo_id").notNull(),
    path: text("path").notNull(),
    blobHash: text("blob_hash").notNull(),
    summary: text("summary").notNull(),
    createdAt: integer("created_at").notNull(),
    /** On the team server already. */
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.path, table.blobHash] })],
);

export const answers = sqliteTable(
  "answers",
  {
    // The full-text index's rowid: an implicit rowid can change on VACUUM, which would detach the index.
    seq: integer("seq").primaryKey(),
    id: text("id").notNull().unique(),
    repoId: text("repo_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    createdAt: integer("created_at").notNull(),
    hits: integer("hits").notNull().default(0),
    author: text("author").notNull(),
    /** On the team server already: pushed from here, or pulled from it. */
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("answers_repo").on(table.repoId)],
);

/** An answer is valid only while every one of its files still has the blob hash recorded here. */
export const answerSources = sqliteTable(
  "answer_sources",
  {
    answerId: text("answer_id")
      .notNull()
      .references(() => answers.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobHash: text("blob_hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.answerId, table.path] })],
);

/** A question's vector, by model: vectors from different models are never compared. Little-endian float32. */
export const answerEmbeddings = sqliteTable("answer_embeddings", {
  answerId: text("answer_id")
    .primaryKey()
    .references(() => answers.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  vector: blob("vector", { mode: "buffer" }).notNull(),
});

/** Repositories this machine shares with the team (rule 3: opt-in, per repository). */
export const teamRepos = sqliteTable("team_repos", {
  repoId: text("repo_id").primaryKey(),
  root: text("root").notNull(),
  addedAt: integer("added_at").notNull(),
});

/** Cursors of the team sync: the last answer and summary seq pulled, the last usage row and hit count pushed. */
export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** A place personal data comes from: a markdown folder, a mailbox, a calendar, or the approved memories. */
export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  /** What `grenier sources` and scopes call it. */
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: ["markdown", "imap", "caldav", "ics", "memory"] }).notNull(),
  /** Where and how to read it, as JSON. Never a password: those come from a command or the keychain. */
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  /** The connector's incremental-sync cursors, as JSON. */
  state: text("state", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  lastSync: integer("last_sync"),
});

/** One note, message or event. `seq` is the full-text index's rowid, as for answers. */
export const items = sqliteTable(
  "items",
  {
    seq: integer("seq").primaryKey(),
    id: text("id").notNull().unique(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["note", "mail", "event", "memory"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** The people involved, as "Name <address>" strings. */
    people: text("people", { mode: "json" }).$type<string[]>().notNull().default([]),
    ts: integer("ts").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [index("items_source").on(table.sourceId), index("items_ts").on(table.ts)],
);

/** Every read of personal data, written before the result is returned (rule 7). */
export const audit = sqliteTable(
  "audit",
  {
    id: integer("id").primaryKey(),
    ts: integer("ts").notNull(),
    clientId: text("client_id").notNull(),
    tool: text("tool").notNull(),
    args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** What was returned. */
    itemIds: text("item_ids", { mode: "json" }).$type<string[]>().notNull(),
  },
  (table) => [index("audit_client_ts").on(table.clientId, table.ts)],
);

/** Memories an AI asked to keep (`remember`), waiting for the user to approve or reject them. */
export const reviewQueue = sqliteTable("review_queue", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  text: text("text").notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  ts: integer("ts").notNull(),
  state: text("state", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  decidedAt: integer("decided_at"),
});

export const budgets = sqliteTable(
  "budgets",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    limitAmount: real("limit_amount").notNull(),
    period: text("period").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key, table.period] })],
);

export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** Tokens are stored hashed. */
  tokenHash: text("token_hash").notNull().unique(),
  /** Source ids this client may read. */
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Usage = typeof usage.$inferSelect;
export type NewUsage = typeof usage.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Budget = typeof budgets.$inferSelect;
export type Answer = typeof answers.$inferSelect;
export type AnswerSource = typeof answerSources.$inferSelect;
export type FileSummary = typeof fileSummaries.$inferSelect;
export type NewAnswer = typeof answers.$inferInsert;
export type NewFileSummary = typeof fileSummaries.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type TeamRepo = typeof teamRepos.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type AuditEntry = typeof audit.$inferSelect;
export type ReviewEntry = typeof reviewQueue.$inferSelect;
