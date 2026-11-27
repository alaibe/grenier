import { randomHex } from "@grenier/core";
import type { Change, StoredRecord } from "@grenier/core/team";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { Hono } from "hono";
import type { z } from "zod";
import type * as schema from "./db/schema.ts";

export interface Member {
  id: string;
  name: string;
  role: "admin" | "member";
}

export interface Device {
  id: string;
  name: string;
  memberId: string;
}

export interface Vars {
  member: Member;
  device: Device;
}

export type { Change, StoredRecord };

export type Db = DrizzleSqliteDODatabase<typeof schema>;

export type Applied = { version: number } | { refused: string } | { conflict: StoredRecord };

/** What the Durable Object lends the remote MCP server and the routines' work: it stays the owner of its storage. */
export interface TeamData {
  storage: DurableObjectStorage;
  db: Db;
  get(id: string): StoredRecord | undefined;
  /** Writes a record and its version in the history, as by this author on this device. */
  put(record: StoredRecord, author: string, device: string): void;
  version(): number;
  nextVersion(): number;
  topsOf(member: Pick<Member, "id">): string[];
  authenticate(request: Request): Promise<{ member: Member; device: Device } | null>;
  /** Tells every connected device there is something new. */
  notify(): void;
  /** Drops every live connection, so a removed device stops at once; the others reconnect. */
  closeSockets(): void;
}

export type TeamApp = Hono<{ Variables: Vars }>;

export const SEEN = 3 * 60 * 1000;

/** A request's JSON body read by its schema, or the 400 that says what is wrong with it. */
export async function bodyAs<T>(
  c: { req: { json: <U>() => Promise<U> } },
  schema: z.ZodType<T>,
): Promise<T | Response> {
  const read = schema.safeParse(await c.req.json<unknown>().catch(() => ({})));
  return read.success ? read.data : problem(400, read.error.issues[0]?.message ?? "the request is not as expected");
}

/** A device's state as the team sees it: offline once it has said nothing for a while. */
export const liveState = (device: { state: string; stateAt: number | null }) =>
  device.stateAt && device.stateAt > Date.now() - SEEN ? device.state : "offline";

export function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export const randomId = (bytes = 12) => randomHex(bytes);

export async function adminOnly(c: { get: (key: "member") => Member }, next: () => Promise<void>) {
  if (c.get("member").role !== "admin") return problem(403, "only an admin can do this");
  return next();
}
