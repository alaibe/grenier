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
export type Client = typeof clients.$inferSelect;
