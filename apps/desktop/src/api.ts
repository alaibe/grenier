import { invoke, isTauri } from "@tauri-apps/api/core";

interface Connection {
  url: string;
  token: string;
}

let connection: Promise<Connection> | undefined;

/**
 * Where the daemon listens and the admin token it wrote in ~/.grenier: from the Tauri shell, which starts the daemon
 * if it is not running, or from VITE_GRENIER_URL and VITE_GRENIER_TOKEN when the UI runs in a browser for development.
 */
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
}

/** One call to the daemon's admin API. Throws ApiError with the daemon's own message. */
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
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`);
  return body;
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
  /** Questions to the exploration cache and its hits; null outside a repository, where no step is traced. */
  asks: number | null;
  hits: number | null;
  /** Whether it took steps in its repository, so the Traces page can replay it. */
  traced?: boolean;
}

export interface Overview {
  version: string;
  days: ReportRow[];
  /** The most spent first. */
  projects: ReportRow[];
  /** The newest first. */
  sessions: SessionRow[];
  /** Today's daily and project limits that spending has passed 80% of, or reached. */
  limits?: { scope: "daily" | "repo"; key: string; limit: number; spent: number; reached: boolean }[];
  cache: { repoId: string; answers: number; hits: number }[];
  sources: number;
  items: number;
  clients: number;
  pendingReview: number;
  /** Sessions the loop guard paused, waiting to be resumed. */
  paused: number;
}

export interface CacheRepo {
  id: string;
  name: string;
  answers: number;
  hits: number;
  summaries: number;
  shared: boolean;
}

export interface CachedAnswer {
  id: string;
  question: string;
  answer: string;
  author: string;
  createdAt: number;
  hits: number;
  shared: boolean;
  /** Why the team server refused it, when it did. */
  shareError: string | null;
  files: string[];
  /** The files changed since it was recorded; null when the repository is not on this machine. */
  changed: string[] | null;
}

export interface BudgetsView {
  daily: number | null;
  session: number | null;
  /** Whether the limit shown comes from config.toml, as no limit was set here or with the command. */
  fromConfig: { daily: boolean; session: boolean };
  repos: { name: string; limit: number }[];
  /** The projects Grenier has seen a session in, for a new project limit. */
  known: string[];
  spentToday: number;
}

export interface PausedSession {
  id: string;
  client: string | null;
  repo: string | null;
  pausedAt: number | null;
}

export interface SourceView {
  name: string;
  kind: string;
  config: Record<string, unknown>;
  items: number;
  lastSync: number | null;
}

export interface SourceSync {
  name: string;
  added: number;
  removed: number;
  error?: string;
}

export interface ClientView {
  name: string;
  scopes: string[];
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  client: string;
  tool: string;
  args: Record<string, unknown>;
  itemIds: string[];
}

export interface ReviewEntry {
  id: string;
  client: string;
  text: string;
  tags: string[];
  ts: number;
}
