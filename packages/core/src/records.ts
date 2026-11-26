import { MAX_SHARED_TEXT, sha256, unshareable } from "./policy.ts";

export interface FieldDef {
  name: string;
  kind: "text" | "number" | "date" | "person" | "record" | "select" | "list" | "json";
  required?: boolean;
  /** For a select: the values it takes. */
  options?: readonly string[];
  /** For a record field: the type the linked record has. */
  type?: string;
}

export interface TypeDef {
  name: string;
  /** What it is for, as the editor and agents read it. */
  description: string;
  fields: readonly FieldDef[];
  /** A Markdown body is part of it: a doc, a meeting's transcript, a memory's text. */
  body: boolean;
  maxBody: number;
  /** The body may quote at most a short snippet of code, as a memory about code may. */
  limitCode?: boolean;
}

export const MEMORY_KINDS = ["answer", "summary", "convention", "fact"] as const;
export const TASK_STATUSES = ["to-do", "doing", "done"] as const;
export const ROUTINE_MODES = ["read-only", "shadow", "limited", "on"] as const;

const LONG = 200_000;

/** The types every team has. Admins add more as records of type Type. */
export const BUILTIN_TYPES: readonly TypeDef[] = [
  {
    name: "Project",
    description: "A piece of work with an owner, linking its repos, tasks, meetings, decisions and docs.",
    fields: [
      { name: "owner", kind: "person" },
      { name: "status", kind: "select", options: ["planned", "active", "done"] },
      { name: "repos", kind: "list" },
    ],
    body: true,
    maxBody: LONG,
  },
  {
    name: "Task",
    description: "Something to do. A task that names a routine is one of its scheduled runs: an idle machine takes it.",
    fields: [
      { name: "status", kind: "select", options: TASK_STATUSES, required: true },
      { name: "owner", kind: "person" },
      { name: "routine", kind: "record", type: "Routine" },
      { name: "result", kind: "text" },
      { name: "machine", kind: "text" },
    ],
    body: true,
    maxBody: LONG,
  },
  {
    name: "Meeting",
    description: "A meeting and its transcript or notes, linked to its project and the people in it.",
    fields: [
      { name: "date", kind: "date", required: true },
      { name: "people", kind: "list" },
    ],
    body: true,
    maxBody: LONG,
  },
  {
    name: "Decision",
    description: "A decision, who owns it, when and why.",
    fields: [
      { name: "owner", kind: "person", required: true },
      { name: "date", kind: "date", required: true },
      { name: "reason", kind: "text", required: true },
    ],
    body: true,
    maxBody: LONG,
  },
  {
    name: "Doc",
    description: "A document: a spec, a guide, a plan, how to set up and run a repo.",
    fields: [],
    body: true,
    maxBody: LONG,
  },
  {
    name: "Person",
    description: "Someone the team works with: a teammate, a customer, a contact.",
    fields: [
      { name: "email", kind: "text" },
      { name: "role", kind: "text" },
      { name: "manager", kind: "person" },
    ],
    body: true,
    maxBody: 20_000,
  },
  {
    name: "Memory",
    description:
      "One thing worth knowing: an answer about code, a summary of a file, a convention, a fact. Short, with what it came from.",
    fields: [
      { name: "kind", kind: "select", options: MEMORY_KINDS, required: true },
      { name: "path", kind: "text" },
    ],
    body: true,
    maxBody: MAX_SHARED_TEXT,
    limitCode: true,
  },
  {
    name: "Skill",
    description: "A skill for the team's agents: SKILL.md and its files, installed on the machines that approve it.",
    fields: [{ name: "files", kind: "json", required: true }],
    body: false,
    maxBody: 0,
  },
  {
    name: "McpServer",
    description:
      "An MCP server's configuration (command or URL, pinned version), and the names of the keys each person enters, never their values.",
    fields: [
      { name: "config", kind: "json", required: true },
      { name: "credentials", kind: "list" },
    ],
    body: true,
    maxBody: 20_000,
  },
  {
    name: "Routine",
    description:
      "One kind of task the team's machines run, in each machine's work folder, on its schedule or by hand: its prompt as the page's text.",
    fields: [
      { name: "schedule", kind: "text" },
      { name: "collector", kind: "select", options: ["yes", "no"] },
      { name: "owner", kind: "person" },
      { name: "agent", kind: "select", options: ["claude", "codex"] },
    ],
    body: true,
    maxBody: 20_000,
  },
  {
    name: "Suggestion",
    description: "An edit the librarian suggests to another record. A person accepts or dismisses it.",
    fields: [
      { name: "target", kind: "record", required: true },
      { name: "change", kind: "json", required: true },
      { name: "reason", kind: "text", required: true },
    ],
    body: false,
    maxBody: 0,
  },
  {
    name: "Type",
    description: "A record type an admin added, with its fields.",
    fields: [{ name: "fields", kind: "json", required: true }],
    body: true,
    maxBody: 20_000,
  },
];

export function builtinType(name: string): TypeDef | undefined {
  return BUILTIN_TYPES.find((type) => type.name === name);
}

/** A type an admin defined, from its record of type Type. */
export function customType(record: { title: string; body: string; fields: Record<string, unknown> }): TypeDef {
  const fields = Array.isArray(record.fields.fields) ? (record.fields.fields as FieldDef[]) : [];
  return { name: record.title, description: record.body, fields, body: true, maxBody: LONG };
}

/** Text that looks like a key, a token or a private key, which no record may hold. */
const SECRETS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bg[ctd]_[A-Za-z0-9_-]{40,}/,
  /\blin_api_[A-Za-z0-9]{30,}/,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
];

export function secretIn(text: string): string | null {
  for (const pattern of SECRETS) if (pattern.test(text)) return "it holds what looks like a key or a token";
  return null;
}

export interface RecordShape {
  type: string;
  kind?: string | null;
  title: string;
  folder?: string;
  body: string;
  fields: Record<string, unknown>;
}

const MAX_FOLDER_DEPTH = 8;

/** Why a folder path is not one, or null: "Decisions/2026", names of 1 to 80 characters, at most 8 deep. */
export function folderProblem(folder: string): string | null {
  if (folder === "") return null;
  if (folder.length > 300) return "a folder path holds at most 300 characters";
  const names = folder.split("/");
  if (names.length > MAX_FOLDER_DEPTH) return `folders nest at most ${MAX_FOLDER_DEPTH} deep`;
  for (const name of names) {
    if (name === "" || name !== name.trim()) return "a folder's name is not empty and has no space around it";
    if (name === "." || name === "..") return `a folder cannot be named ${name}`;
    if (name.length > 80) return "a folder's name holds at most 80 characters";
    if (/\p{Cc}/u.test(name)) return "a folder's name holds no control characters";
  }
  return null;
}

interface MemberChange {
  top: string;
  type: string;
  title: string;
  folder?: string;
  body: string;
  fields: Record<string, unknown>;
  retiredAt?: number | null;
}

/** The fields of a routine's task the machine that runs it sets. */
const RUN_FIELDS = new Set(["status", "result", "machine"]);

export const MEMBER_WRITES =
  "only an admin writes there: a member writes in me, and their agents' answers in a repository's folder";

/**
 * Whether a member who is not an admin may make this change: anything in their own `me` (`mine`), a memory in a
 * repository's folder (what their agents work out about its code), and the run fields of a routine's task their machine ran.
 */
export function memberMay(
  before: MemberChange | undefined,
  after: MemberChange,
  mine: string,
  ranIt: boolean,
): boolean {
  if (after.top === mine && (!before || before.top === mine)) return true;
  const answer = (record: { top: string; type: string }) =>
    (record.type === "Doc" || record.type === "Memory") && record.top.startsWith("repo:");
  if (answer(after) && (!before || answer(before))) return true;
  if (before?.type !== "Task" || after.type !== "Task" || !ranIt) return false;
  const kept = ["top", "title", "folder", "body", "retiredAt"] as const;
  if (kept.some((part) => (before[part] ?? null) !== (after[part] ?? null))) return false;
  const names = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  return [...names].every(
    (name) => RUN_FIELDS.has(name) || JSON.stringify(before.fields[name]) === JSON.stringify(after.fields[name]),
  );
}

/** Why a record does not follow its type's rules, or null. Every write is checked. */
export function recordProblem(record: RecordShape, type: TypeDef | undefined): string | null {
  if (!type) return `there is no type ${record.type}`;
  const title = record.title.trim();
  if (title === "") return "a record needs a title";
  if (title.length > 300) return "a title holds at most 300 characters";
  const folder = folderProblem(record.folder ?? "");
  if (folder) return folder;
  if (!type.body && record.body.trim() !== "") return `a ${type.name} has no body`;
  if (record.body.length > type.maxBody) return `a ${type.name}'s body holds at most ${type.maxBody} characters`;
  const secret = secretIn(`${title}\n${record.folder ?? ""}\n${record.body}\n${JSON.stringify(record.fields)}`);
  if (secret) return secret;
  if (type.limitCode && record.body.trim() !== "") {
    const problem = unshareable(record.body);
    if (problem) return problem;
  }
  for (const field of type.fields) {
    const value = record.fields[field.name];
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required) return `a ${type.name} needs ${field.name}`;
      continue;
    }
    if (field.kind === "select" && field.options && !field.options.includes(String(value))) {
      return `${field.name} takes ${field.options.join(", ")}, not ${String(value)}`;
    }
    if (field.kind === "number" && typeof value !== "number") return `${field.name} takes a number`;
    if (field.kind === "date" && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
      return `${field.name} takes a date, as 2026-11-22`;
    }
    if (field.kind === "list" && !Array.isArray(value)) return `${field.name} takes a list`;
  }
  if (type.name === "Memory" && record.kind !== record.fields.kind) return "a memory's kind is its kind field";
  return null;
}

export function repoTop(repoId: string): string {
  return `repo:${repoId}`;
}

/** The six digits both screens show while a device joins, from the invite secret's hash and the device's nonce. */
export async function joinCode(secretHash: string, nonce: string): Promise<string> {
  const digest = await sha256(`${secretHash}:${nonce}`);
  return String(Number.parseInt(digest.slice(0, 12), 16) % 1_000_000).padStart(6, "0");
}
