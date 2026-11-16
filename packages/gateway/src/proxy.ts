import { budgetMessage, type Config, effectiveLimits, firstBreach } from "@grenier/core";
import { costOf, type Prices, repoName, startOfToday } from "@grenier/log";
import type { Session, Store } from "@grenier/store";
import { LoopWatch, type ToolCall } from "./loops.ts";
import { UsageReader } from "./usage.ts";

export const UNTAGGED = "untagged";

export interface ProxyOptions {
  store: Store;
  config: Config;
  prices: Prices;
  fetch?: typeof fetch;
  now?: () => number;
  /** Shows a desktop notification. The daemon passes one; tests record the calls. */
  notify?: (title: string, message: string) => void;
  /** How often a held request looks for `grenier resume`, in milliseconds. */
  pollInterval?: number;
  /** When this process started: sessions older than it get their history marked as seen, not counted. */
  startedAt?: number;
}

// Hop-by-hop headers (RFC 9110 §7.6.1) and the ones fetch sets itself.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/** Forwards one request to the upstream and streams the answer back, after the session's guards let it through. */
export function createProxy(options: ProxyOptions) {
  const { store, config, prices } = options;
  const fetchUpstream = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const notify = options.notify ?? (() => {});
  const pollInterval = options.pollInterval ?? 500;
  const startedAt = options.startedAt ?? now();
  const loops = new LoopWatch(config.guards.loop_repeat_threshold, config.guards.loop_window);
  const upstream = new URL(config.proxy.upstream_anthropic);

  async function sessionFor(id: string): Promise<Session> {
    const existing = await store.sessions.get(id);
    if (existing) return existing;
    await store.sessions.create({ id, startedAt: now() });
    return (await store.sessions.get(id)) as Session;
  }

  async function onLoops(session: Session, calls: ToolCall[]): Promise<void> {
    for (const call of calls) {
      const detail = {
        tool: call.tool,
        hash: call.hash,
        threshold: config.guards.loop_repeat_threshold,
        window: config.guards.loop_window,
        action: config.guards.on_loop,
      };
      await store.events.add({ sessionId: session.id, ts: now(), kind: "loop", detail: JSON.stringify(detail) });
      const what = call.tool === "error" ? "The same tool error" : `The same ${call.tool} call`;
      const repeated = `${what} came ${config.guards.loop_repeat_threshold} times in the last ${config.guards.loop_window} tool calls`;
      if (config.guards.on_loop === "pause") {
        await store.sessions.setPaused(session.id, true);
        await store.events.add({ sessionId: session.id, ts: now(), kind: "pause", detail: JSON.stringify(detail) });
        notify("Grenier paused a session", `${repeated}. Run: grenier resume ${session.id}`);
      } else {
        notify("Grenier: possible loop", `${repeated} (session ${session.id}).`);
      }
    }
  }

  /** Waits while the session is paused. False when the pause outlasted the timeout or the client went away. */
  async function waitWhilePaused(id: string, signal: AbortSignal): Promise<boolean> {
    const deadline = now() + config.guards.pause_timeout * 1000;
    while ((await store.sessions.get(id))?.paused) {
      if (signal.aborted || now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    return true;
  }

  async function budgetBreach(session: Session) {
    const stored = await store.budgets.list();
    const name = session.repoRoot ? repoName(session.repoRoot) : null;
    const limits = effectiveLimits(config.budgets, stored, name);
    if (limits.length === 0) return null;
    const today = startOfToday(now());
    const spent = new Map<string, number>();
    for (const limit of limits) {
      if (limit.scope === "daily") spent.set("daily", await store.usage.spend({ since: today }));
      if (limit.scope === "session") spent.set("session", await store.usage.spend({ sessionId: session.id }));
      if (limit.scope === "repo" && session.repoId) {
        spent.set("repo", await store.usage.spend({ since: today, repoId: session.repoId }));
      }
    }
    return firstBreach(limits, (limit) => spent.get(limit.scope) ?? 0);
  }

  return async function proxy(request: Request, sessionId: string, path: string): Promise<Response> {
    const session = await sessionFor(sessionId);
    const inference = request.method === "POST" && /\/v1\/messages\/?$/.test(path);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const parsed = inference && body ? parseJson(body) : undefined;

    if (parsed) await onLoops(session, await loops.observe(session.id, parsed, session.startedAt < startedAt));

    if (!(await waitWhilePaused(session.id, request.signal))) {
      return errorResponse(
        429,
        "rate_limit_error",
        `Grenier paused this session after a possible loop. To let it continue, run: grenier resume ${session.id}`,
      );
    }

    if (inference) {
      const breach = await budgetBreach(session);
      if (breach) {
        await store.events.add({ sessionId: session.id, ts: now(), kind: "budget", detail: JSON.stringify(breach) });
        return errorResponse(429, "rate_limit_error", budgetMessage(breach));
      }
    }

    const target = new URL(upstream);
    target.pathname = upstream.pathname.replace(/\/$/, "") + path;
    target.search = new URL(request.url).search;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.append(name, value);
    }
    headers.set("accept-encoding", "identity");

    const response = await fetchUpstream(target, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
      redirect: "manual",
    });

    const responseHeaders = new Headers();
    for (const [name, value] of response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.append(name, value);
    }
    if (!inference || !response.body) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    const reader = new UsageReader(response.headers.get("content-type"));
    const requestedModel = typeof parsed?.model === "string" ? parsed.model : null;
    let recorded = false;
    const record = async () => {
      if (recorded) return;
      recorded = true;
      const usage = reader.result();
      const model = usage.model ?? requestedModel;
      await store.usage.add({
        sessionId: session.id,
        ts: now(),
        model,
        inputTokens: usage.inputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        cost: costOf(model, usage, prices),
        status: response.status,
      });
    };
    request.signal.addEventListener("abort", () => void record(), { once: true });

    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        reader.push(chunk);
      },
      flush: record,
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}

interface MessagesRequest {
  model?: unknown;
  messages?: { role?: string; content?: unknown }[];
}

function parseJson(body: ArrayBuffer): MessagesRequest | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value !== null && typeof value === "object" ? (value as MessagesRequest) : undefined;
  } catch {
    return undefined;
  }
}

/** An Anthropic-style error that SDK clients and Claude Code show without retrying. */
export function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
}
