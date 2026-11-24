import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ScreenUrl } from "./usage/screens.ts";

interface Connection {
  url: string;
  token: string;
}

let connection: Promise<Connection> | undefined;

/** From the Tauri shell, or from VITE_GRENIER_URL and VITE_GRENIER_TOKEN when the UI runs in a browser. */
function connect(): Promise<Connection> {
  if (connection) return connection;
  const attempt: Promise<Connection> = isTauri()
    ? invoke<Connection>("daemon_connection")
    : Promise.resolve({
        url: import.meta.env.VITE_GRENIER_URL ?? "http://127.0.0.1:7788",
        token: import.meta.env.VITE_GRENIER_TOKEN ?? "",
      });
  // A daemon that could not start is tried again at the next call, not remembered as broken.
  const current = attempt.catch((reason: unknown) => {
    if (connection === current) connection = undefined;
    throw new ApiError(typeof reason === "string" ? reason : String((reason as Error)?.message ?? reason));
  });
  connection = current;
  return current;
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status = 0,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { url, token } = await connect();
  let response: Response;
  try {
    response = await fetch(`${url}/admin${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    connection = undefined;
    throw new ApiError("The Grenier daemon is not answering. It restarts with the app.");
  }
  if (response.status === 401) {
    connection = undefined;
    throw new ApiError(
      "The daemon refused this app's admin token: another daemon, with another GRENIER_HOME, may be on its port. Run grenier doctor.",
    );
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status, body);
  return body;
}

/** The shell alone decides whether a page view is sent. */
export function sendPageView(screen: ScreenUrl): void {
  if (!isTauri()) return;
  invoke("usage_page_view", { screen, width: window.screen.width, height: window.screen.height }).catch(() => {});
}

const OUTSIDE_THE_APP = "Settings are kept by the desktop app: open this page in Grenier.";

export function usageEnabled(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("usage_enabled") : Promise.reject(new ApiError(OUTSIDE_THE_APP));
}

export function setUsageEnabled(enabled: boolean): Promise<void> {
  return isTauri() ? invoke<void>("usage_set_enabled", { enabled }) : Promise.reject(new ApiError(OUTSIDE_THE_APP));
}

export interface ReportRow {
  key: string;
  requests: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
  saved: number;
}

export interface SessionRow extends ReportRow {
  client: string | null;
  /** Null for requests of an agent not started with `grenier run`. */
  project: string | null;
  startedAt: number | null;
}

export interface Overview {
  version: string;
  /** Who writes from this machine: the member's name in the team, else this computer's user. */
  me: string | null;
  days: ReportRow[];
  /** The most spent first. */
  projects: ReportRow[];
  /** The newest first. */
  sessions: SessionRow[];
  /** Records changed here that the team store has not taken yet. */
  waiting: number;
  team: { url: string; lastSync: number | null } | null;
  /** In a team, this machine's person's role: a member writes in me only, and their agents' answers. */
  role: "admin" | "member" | null;
  /** Sessions the loop guard paused, waiting to be resumed. */
  paused: number;
}

export interface Space {
  id: string;
  name: string;
  kind: "me" | "repo" | "team" | "custom";
  repoId: string | null;
  root: string | null;
  records: number;
}

export interface FieldDef {
  name: string;
  kind: "text" | "number" | "date" | "person" | "record" | "select" | "list" | "json";
  required?: boolean;
  options?: readonly string[];
  type?: string;
}

export interface TypeDef {
  name: string;
  description: string;
  fields: readonly FieldDef[];
  body: boolean;
  maxBody: number;
}

export interface Anchor {
  kind: "git" | "item";
  repoId: string | null;
  ref: string;
  version: string;
}

export interface Link {
  kind: "record" | "person" | "repo" | "path" | "issue";
  ref: string;
}

/** A record as lists show it. */
export interface RecordRow {
  id: string;
  space: string;
  type: string;
  kind: string | null;
  title: string;
  /** Where it sits in its top folder, as "Decisions/2026"; empty at the top. */
  folder: string;
  body: string;
  fields: Record<string, unknown>;
  author: string;
  updatedAt: number;
  /** Whether the code it was written from is unchanged: stale when a file it names changed since. */
  status: "hit" | "stale" | "unchecked";
  changed: string[];
  anchors: Anchor[];
  links: Link[];
}

/** A page in Knowledge's tree. */
export interface PageRow {
  id: string;
  space: string;
  folder: string;
  title: string;
  type: string;
  updatedAt: number;
}

export interface RecordFull extends RecordRow {
  device: string;
  createdAt: number;
  version: number;
  retiredAt: number | null;
  hits: number;
  linksTo: { id: string; title: string; type: string }[];
  linkedFrom: { id: string; title: string; type: string }[];
}

export interface HistoryEntry {
  version: number;
  author: string;
  device: string | null;
  ts: number;
  snapshot: Partial<RecordFull>;
}

export interface Member {
  name: string;
  role: "admin" | "member";
  createdAt: number;
  devices: { id: string; name: string; state: string; lastSeen: number | null }[];
}

export interface Invite {
  id: string;
  member: string;
  role: string;
  expiresAt: number;
  device: string | null;
  /** The six digits the joining device shows, once it asked to join. */
  code: string | null;
}

export interface Machine {
  id: string;
  name: string;
  member: string;
  state: string;
  lastSeen: number | null;
  runs: number;
}

export interface TeamUsage {
  day: string;
  repo: string;
  member: string;
  machine: string;
  requests: number;
  cost: number;
  routine_minutes: number;
}

export interface Run {
  id: string;
  routine_id: string;
  task_id: string | null;
  machine: string;
  version: number;
  kind: "run" | "eval";
  status: string;
  started_at: number;
  ended_at: number | null;
  actions: number;
  cost: number;
  landed: number | null;
  score: number | null;
  thumbs: number | null;
}

export interface Joining {
  state: "idle" | "waiting" | "joined" | "failed";
  code?: string;
  error?: string;
  url?: string;
  member?: string;
}

export interface PausedSession {
  id: string;
  client: string | null;
  repo: string | null;
  pausedAt: number | null;
}

export interface ClientView {
  name: string;
  scopes: string[];
  createdAt: number;
}
