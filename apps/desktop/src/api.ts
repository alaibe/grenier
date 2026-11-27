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
      "The daemon refused this app's admin token: another daemon, with another GRENIER_HOME, may be on its port.",
    );
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status, body);
  return body;
}

/** The pages closest to some words, as Knowledge's search and `@` links find them. */
export function searchRecords<T>(words: string): Promise<T[]> {
  return api<{ records: T[] }>(`/records?q=${encodeURIComponent(words)}`).then((answer) => answer.records);
}

/** The shell alone decides whether a page view is sent. */
export function sendPageView(screen: ScreenUrl): void {
  if (!isTauri()) return;
  invoke("usage_page_view", { screen, width: window.screen.width, height: window.screen.height }).catch(() => {});
}

/** The system's folder picker, opened at `from`; null when the person cancels. */
export function pickFolder(from: string): Promise<string | null> {
  return isTauri() ? invoke<string | null>("pick_folder", { from }) : Promise.reject(new ApiError(OUTSIDE_THE_APP));
}

const OUTSIDE_THE_APP = "Settings are kept by the desktop app: open this page in Grenier.";

export function usageEnabled(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("usage_enabled") : Promise.reject(new ApiError(OUTSIDE_THE_APP));
}

export function setUsageEnabled(enabled: boolean): Promise<void> {
  return isTauri() ? invoke<void>("usage_set_enabled", { enabled }) : Promise.reject(new ApiError(OUTSIDE_THE_APP));
}

/** The public issue form for a problem or an idea, in the person's browser, with only the version and the system filled in. */
export function openFeedback(kind: "problem" | "feature"): Promise<void> {
  return isTauri() ? invoke<void>("open_feedback", { kind }) : Promise.reject(new ApiError(OUTSIDE_THE_APP));
}
