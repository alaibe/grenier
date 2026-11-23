import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Times are Unix milliseconds. Edit this file, then `pnpm db:generate` writes the migration.
// The full-text index on records and its triggers are hand-written SQL in a custom migration, not modelled here.

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

/** Loop detected, pause, resume, a tool cut off. */
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

/**
 * Where an agent went in its repository: one row per file (or search) a tool call touched, for the desktop app to
 * replay. Paths, line ranges and hashes of written lines only, never a command or what a file holds.
 */
export const steps = sqliteTable(
  "steps",
  {
    id: integer("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    callId: text("call_id").notNull(),
    /** Which of the call's files this is: a shell command can read several. */
    part: integer("part").notNull().default(0),
    ts: integer("ts").notNull(),
    tool: text("tool").notNull(),
    kind: text("kind", { enum: ["read", "edit", "search", "list", "ask"] }).notNull(),
    /** Relative to the repository's root; null for the whole repository. */
    path: text("path"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    /** A search's pattern or a question to the store, shortened, with anything like a key taken out. */
    label: text("label"),
    /** "error" for a failed call; recall's hit, stale or miss for an ask. */
    outcome: text("outcome"),
    /** For an edit: a hash of each line it wrote, trimmed, to tell later whether they landed. */
    lineHashes: text("line_hashes", { mode: "json" }).$type<string[]>(),
  },
  (table) => [uniqueIndex("steps_call").on(table.sessionId, table.callId, table.part)],
);

/** Small values this machine keeps: the team cursor, its device name, the personal key's id. */
export const state = sqliteTable("state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** The spaces this machine knows: `me`, one per repository, `team`, and those the team made. */
export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["me", "repo", "team", "custom"] }).notNull(),
  /** For a repository's space: its id, the hash of its first commit. */
  repoId: text("repo_id"),
  /** Where the repository is on this machine, when it is. */
  root: text("root"),
});

/**
 * One thing worth keeping: a project, task, meeting, decision, doc, person or memory, a skill, an MCP server, a
 * routine. `seq` is the full-text index's rowid: an implicit rowid can change on VACUUM.
 */
export const records = sqliteTable(
  "records",
  {
    seq: integer("seq").primaryKey(),
    id: text("id").notNull().unique(),
    space: text("space").notNull(),
    type: text("type").notNull(),
    /** A memory's kind: answer, summary, convention or fact. */
    kind: text("kind"),
    title: text("title").notNull(),
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
  (table) => [index("records_space_type").on(table.space, table.type), index("records_updated").on(table.updatedAt)],
);

/** What a record was worked out from, at the version read: a file and its blob hash, or an outside item. */
export const anchors = sqliteTable(
  "anchors",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => records.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["git", "item"] }).notNull(),
    /** For a file: its repository's id. */
    repoId: text("repo_id"),
    /** A path relative to the repository, or an item's ref (`linear:acme/LIN-123`). */
    ref: text("ref").notNull(),
    version: text("version").notNull(),
  },
  (table) => [primaryKey({ columns: [table.recordId, table.kind, table.ref] })],
);

/** What a record points at: another record, a person, a repository, a path, an issue. Never makes it stale. */
export const links = sqliteTable(
  "links",
  {
    recordId: text("record_id")
      .notNull()
      .references(() => records.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["record", "person", "repo", "path", "issue"] }).notNull(),
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

/** Every version of a record, as the team store numbered it, with who made it. */
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
  /** Why the team store refused it, when it did: it stays here, and sync passes over it. */
  refused: text("refused"),
});

/**
 * What this machine's person approved to run or install here, by hash: a skill, an MCP server, a routine, a
 * routine's workflow file. A change to the item needs approval again.
 */
export const approvals = sqliteTable(
  "approvals",
  {
    recordId: text("record_id").notNull(),
    kind: text("kind", { enum: ["skill", "mcp", "routine", "workflow"] }).notNull(),
    hash: text("hash").notNull(),
    approvedAt: integer("approved_at").notNull(),
    /** For a routine on this machine: its mode, its extra tools and daily action limit. */
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    /** Where it was installed and the hash installed before, to go back. */
    installedPath: text("installed_path"),
    previousHash: text("previous_hash"),
  },
  (table) => [primaryKey({ columns: [table.recordId, table.kind] })],
);

/** A routine's runs on this machine. */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id").notNull(),
    taskId: text("task_id"),
    version: integer("version").notNull(),
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

/** What a session's spend turned into, worked out once its edits had time to land. */
export const outcomes = sqliteTable("outcomes", {
  sessionId: text("session_id").primaryKey(),
  writtenLines: integer("written_lines").notNull(),
  landedLines: integer("landed_lines").notNull(),
  /** Spend on reading what a hit already covered. */
  rediscovery: real("rediscovery").notNull(),
  issueKeys: text("issue_keys", { mode: "json" }).$type<string[]>().notNull().default([]),
  computedAt: integer("computed_at").notNull(),
});

/** Every read a client made of the store, written before the result is returned. */
export const audit = sqliteTable(
  "audit",
  {
    id: integer("id").primaryKey(),
    ts: integer("ts").notNull(),
    clientId: text("client_id").notNull(),
    tool: text("tool").notNull(),
    args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** What was returned. */
    recordIds: text("record_ids", { mode: "json" }).$type<string[]>().notNull(),
  },
  (table) => [index("audit_client_ts").on(table.clientId, table.ts)],
);

/** Tokens for the agents and apps that use the store over MCP, with the spaces each may read. */
export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  /** Space ids this client may read, or "*" for every space. */
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
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type Space = typeof spaces.$inferSelect;
export type RecordRow = typeof records.$inferSelect;
export type Anchor = typeof anchors.$inferSelect;
export type Link = typeof links.$inferSelect;
export type HistoryEntry = typeof history.$inferSelect;
export type OutboxEntry = typeof outbox.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Outcome = typeof outcomes.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type AuditEntry = typeof audit.$inferSelect;
