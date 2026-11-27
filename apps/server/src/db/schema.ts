import type { Anchor, Link } from "@grenier/core/api";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Times are Unix milliseconds; the full-text index `records_fts` lives in a custom migration.

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  role: text("role").$type<"admin" | "member">().notNull(),
  createdAt: integer("created_at").notNull(),
  removedAt: integer("removed_at"),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
  lastSeen: integer("last_seen"),
  state: text("state").notNull().default("offline"),
  room: real("room").notNull().default(0),
  agents: text("agents", { mode: "json" }).$type<string[]>().notNull().default([]),
  stateAt: integer("state_at"),
});

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  secretHash: text("secret_hash").notNull(),
  memberName: text("member_name").notNull(),
  role: text("role").$type<"admin" | "member">().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  deviceName: text("device_name"),
  deviceHash: text("device_hash"),
  nonce: text("nonce"),
  askedAt: integer("asked_at"),
});

export const records = sqliteTable(
  "records",
  {
    id: text("id").primaryKey(),
    top: text("top").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    folder: text("folder").notNull().default(""),
    body: text("body").notNull(),
    fields: text("fields", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    author: text("author").notNull(),
    device: text("device"),
    sessionId: text("session_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    retiredAt: integer("retired_at"),
    version: integer("version").notNull().unique(),
    anchors: text("anchors", { mode: "json" }).$type<Anchor[]>().notNull(),
    links: text("links", { mode: "json" }).$type<Link[]>().notNull(),
    sealed: text("sealed"),
  },
  (table) => [index("records_top").on(table.top, table.type)],
);

export const history = sqliteTable(
  "history",
  {
    recordId: text("record_id").notNull(),
    version: integer("version").notNull(),
    author: text("author").notNull(),
    device: text("device"),
    ts: integer("ts").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.recordId, table.version] })],
);

export const applied = sqliteTable("applied", {
  changeId: text("change_id").primaryKey(),
  version: integer("version").notNull(),
  at: integer("at").notNull(),
});

export const claims = sqliteTable("claims", {
  taskId: text("task_id").primaryKey(),
  deviceId: text("device_id").notNull(),
  leasedUntil: integer("leased_until").notNull(),
  offeredAt: integer("offered_at").notNull(),
});

export const declines = sqliteTable(
  "declines",
  {
    taskId: text("task_id").notNull(),
    deviceId: text("device_id").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.deviceId] })],
);

export const usage = sqliteTable(
  "usage",
  {
    deviceId: text("device_id").notNull(),
    day: text("day").notNull(),
    repo: text("repo").notNull(),
    requests: integer("requests").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cost: real("cost").notNull(),
    routineMinutes: real("routine_minutes").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.day, table.repo] })],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  routineId: text("routine_id").notNull(),
  taskId: text("task_id"),
  deviceId: text("device_id").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  actions: integer("actions").notNull(),
  cost: real("cost").notNull(),
});

export const weblinks = sqliteTable("weblinks", {
  codeHash: text("code_hash").primaryKey(),
  memberId: text("member_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

export const schedules = sqliteTable("schedules", {
  routineId: text("routine_id").primaryKey(),
  nextAt: integer("next_at").notNull(),
});

/** The store's one change counter: every record version comes from it, in order. */
export const counter = sqliteTable("counter", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
});
