import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Times are Unix milliseconds; the full-text index and its triggers live in a custom migration.

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
    /** The routine run this session is, if any: its tools are held to the run's allowlist. */
    runId: text("run_id"),
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

/** Loop detected, pause, resume, a model with no price, a request body the proxy changed. */
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

/** Small values this machine keeps: team cursor, last sync, member, role, `me` top folder. */
export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** The repositories this machine has seen: a page's files are checked in the one its anchors name. */
export const repos = sqliteTable("repos", {
  /** The hash of its first commit, the same on every machine. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Where it lives on this machine. */
  root: text("root").notNull(),
});

/** `seq` is the full-text index's rowid: an implicit rowid can change on VACUUM. */
export const records = sqliteTable(
  "records",
  {
    seq: integer("seq").primaryKey(),
    id: text("id").notNull().unique(),
    top: text("top").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    /** Where the record sits in its top folder, as "Decisions/2026"; empty at the top. */
    folder: text("folder").notNull().default(""),
    body: text("body").notNull().default(""),
    fields: text("fields", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    author: text("author").notNull(),
    device: text("device"),
    sessionId: text("session_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    retiredAt: integer("retired_at"),
    /** The team store's number for this version; 0 while it has never reached it. */
    version: integer("version").notNull().default(0),
    /** Reuses through recall while it was a hit. */
    hits: integer("hits").notNull().default(0),
  },
  (table) => [index("records_top_type").on(table.top, table.type), index("records_updated").on(table.updatedAt)],
);

/** What a record was worked out from, at the version read: a file and its blob hash, or an outside item. */
export const anchors = sqliteTable(
  "anchors",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => records.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["git", "item"] }).notNull(),
    repoId: text("repo_id"),
    /** A path relative to the repository, or an item's ref (`linear:acme/LIN-123`). */
    ref: text("ref").notNull(),
    version: text("version").notNull(),
  },
  (table) => [primaryKey({ columns: [table.recordId, table.kind, table.ref] })],
);

/** What a record points at: another record, or a repository. Never makes it stale. */
export const links = sqliteTable(
  "links",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => records.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["record", "repo"] }).notNull(),
    ref: text("ref").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.kind, table.ref] }),
    index("links_ref").on(table.kind, table.ref),
  ],
);

/** A record's title and body as a vector, by model: vectors from different models are never compared. */
export const recordEmbeddings = sqliteTable("record_embeddings", {
  recordId: text("record_id")
    .primaryKey()
    .references(() => records.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  vector: blob("vector", { mode: "buffer" }).notNull(),
});

export const history = sqliteTable(
  "history",
  {
    id: integer("id").primaryKey(),
    recordId: text("record_id").notNull(),
    version: integer("version").notNull(),
    author: text("author").notNull(),
    device: text("device"),
    ts: integer("ts").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [uniqueIndex("history_record_version").on(table.recordId, table.version)],
);

/** Changes made here and not yet taken by the team store, oldest first. Resent with the same id until taken. */
export const outbox = sqliteTable("outbox", {
  id: text("id").primaryKey(),
  seq: integer("seq").notNull(),
  recordId: text("record_id").notNull(),
  change: text("change", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  baseVersion: integer("base_version").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** What this machine's person approved, by hash: a change to the item needs approval again. */
export const approvals = sqliteTable(
  "approvals",
  {
    recordId: text("record_id").notNull(),
    kind: text("kind", { enum: ["skill", "mcp", "routine"] }).notNull(),
    hash: text("hash").notNull(),
    approvedAt: integer("approved_at").notNull(),
    /** For a routine on this machine: its mode, its extra tools and daily action limit. */
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    /** The hash installed before, to go back. */
    previousHash: text("previous_hash"),
  },
  (table) => [primaryKey({ columns: [table.recordId, table.kind] })],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id").notNull(),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    trigger: text("trigger").notNull(),
    status: text("status", { enum: ["running", "done", "failed", "cut"] }).notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    actions: integer("actions").notNull().default(0),
    result: text("result"),
  },
  (table) => [index("runs_routine").on(table.routineId, table.startedAt)],
);

/** Tokens for the agents and apps that use the store over MCP, with the top folders each may read. */
export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  /** The ids of the top folders this client may read, or "*" for every one. */
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
});

/** The skills, MCP servers and tools this machine's agents used, counted from their transcripts, by day. */
export const toolUses = sqliteTable(
  "tool_uses",
  {
    /** YYYY-MM-DD, in the machine's time zone. */
    day: text("day").notNull(),
    agent: text("agent").notNull(),
    /** The folder the agent ran in. */
    project: text("project").notNull(),
    kind: text("kind", { enum: ["skill", "server"] }).notNull(),
    /** The skill's or the server's name as the agent called it. */
    subject: text("subject").notNull(),
    tool: text("tool").notNull(),
    calls: integer("calls").notNull(),
    errors: integer("errors").notNull(),
    lastAt: integer("last_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.agent, table.project, table.kind, table.subject, table.tool] }),
    index("tool_uses_subject").on(table.kind, table.subject),
  ],
);

/** How far each agent transcript was read into tool_uses. */
export const transcripts = sqliteTable("transcripts", {
  path: text("path").primaryKey(),
  offset: integer("offset").notNull(),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Usage = typeof usage.$inferSelect;
export type NewUsage = typeof usage.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type KnownRepo = typeof repos.$inferSelect;
export type RecordRow = typeof records.$inferSelect;
export type Anchor = typeof anchors.$inferSelect;
export type Link = typeof links.$inferSelect;
export type HistoryEntry = typeof history.$inferSelect;
export type OutboxEntry = typeof outbox.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type ToolUse = typeof toolUses.$inferSelect;
