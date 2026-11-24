import type { Hono } from "hono";

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

/** A record as the team store keeps it. In a `me` top folder, `sealed` holds it encrypted and the rest is empty. */
export interface StoredRecord {
  id: string;
  top: string;
  type: string;
  kind: string | null;
  title: string;
  folder: string;
  body: string;
  fields: Record<string, unknown>;
  author: string;
  device: string | null;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
  version: number;
  anchors: { kind: string; repoId: string | null; ref: string; version: string }[];
  links: { kind: string; ref: string }[];
  sealed: string | null;
}

export interface Change {
  id: string;
  recordId: string;
  baseVersion: number;
  changed: string[];
  record: Partial<StoredRecord> & { id: string };
  /** Refuse instead of overwriting a field someone else changed since `baseVersion`: the editor's save. */
  check?: boolean;
}

export type Row = Record<string, SqlStorageValue>;

export type Applied = { version: number } | { refused: string } | { conflict: StoredRecord };

/** What the Durable Object lends the remote MCP server and the routines' work: it stays the owner of its storage. */
export interface TeamData {
  storage: DurableObjectStorage;
  sql(query: string, ...bindings: SqlStorageValue[]): Row[];
  one(query: string, ...bindings: SqlStorageValue[]): Row | undefined;
  record(row: Row): StoredRecord;
  get(id: string): StoredRecord | undefined;
  put(record: StoredRecord, member: Member, device: Device): void;
  nextVersion(): number;
  topsOf(member: Member): string[];
  apply(change: Change, member: Member, device: Device): Applied;
  authenticate(request: Request): Promise<{ member: Member; device: Device } | null>;
  notify(): void;
}

export type TeamApp = Hono<{ Variables: Vars }>;

export const SEEN = 3 * 60 * 1000;

export function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function randomId(bytes = 12): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function adminOnly(c: { get: (key: "member") => Member }, next: () => Promise<void>) {
  if (c.get("member").role !== "admin") return problem(403, "only an admin can do this");
  return next();
}
