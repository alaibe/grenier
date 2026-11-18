import { budgetMessage, type Config, effectiveLimits, firstBreach } from "@grenier/core";
import { costOf, type Prices, repoName, startOfToday } from "@grenier/log";
import type { Session, Store } from "@grenier/store";
import { LoopWatch, type ToolCall, type ToolUse } from "./loops.ts";
import { OpenAIUsageReader } from "./openai.ts";
import { placeEdits, stepsOf } from "./trace.ts";
import { UsageReader } from "./usage.ts";

/** Which API a request is for: Anthropic's Messages API, or OpenAI's (under /openai/ on the proxy). */
export type Provider = "anthropic" | "openai";

const INFERENCE: Record<Provider, RegExp> = {
  anthropic: /\/v1\/messages\/?$/,
  openai: /\/v1\/(chat\/completions|responses|completions)\/?$/,
};

export const UNTAGGED = "untagged";

export interface ProxyOptions {
  store: Store;
  config: Config;
  prices: Prices;
  fetch?: typeof fetch;
  now?: () => number;
  /** Shows a desktop notification. The daemon passes one; tests record the calls. */
  notify?: (title: string, message: string) => void;
  log?: (line: string) => void;
  /** How often a held request looks for `grenier resume`, in milliseconds. */
  pollInterval?: number;
  /** When this process started: sessions older than it get their history marked as seen, not counted. */
  startedAt?: number;
  /** Today's team and member limits and spend, from the team server; null when there is no team. */
  teamBudget?: () => Promise<{
    team: { limit: number | null; spent: number };
    member: { limit: number | null; spent: number };
  } | null>;
}

const TEAM_BUDGET_TTL = 15_000;

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
  const log = options.log ?? (() => {});
  const pollInterval = options.pollInterval ?? 500;
  const startedAt = options.startedAt ?? now();
  const loops = new LoopWatch(config.guards.loop_repeat_threshold, config.guards.loop_window);
  const upstreams: Record<Provider, URL> = {
    anthropic: new URL(config.proxy.upstream_anthropic),
    openai: new URL(config.proxy.upstream_openai),
  };

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

  /**
   * Keeps where the session's new calls went in its repository, for the desktop app's traces. The request does not
   * wait for it, and it never fails one.
   */
  async function recordSteps(session: Session, uses: ToolUse[]): Promise<void> {
    if (!session.repoRoot || uses.length === 0) return;
    try {
      const rows = stepsOf({ id: session.id, repoRoot: session.repoRoot, cwd: session.cwd }, uses, now());
      if (rows.length === 0) return;
      await placeEdits(session.repoRoot, rows, uses);
      await store.steps.add(rows);
    } catch (error) {
      log(`grenier: could not record the steps of session ${session.id}: ${(error as Error).message}`);
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

  let teamStatus: { at: number; value: Awaited<ReturnType<NonNullable<ProxyOptions["teamBudget"]>>> } | undefined;
  async function teamBreach() {
    if (!options.teamBudget) return null;
    if (!teamStatus || now() - teamStatus.at > TEAM_BUDGET_TTL) {
      // A team server that cannot be reached does not stop anyone's work: the request goes through.
      teamStatus = { at: now(), value: await options.teamBudget().catch(() => null) };
    }
    const status = teamStatus.value;
    if (!status) return null;
    if (status.team.limit !== null && status.team.spent >= status.team.limit) {
      return { scope: "team" as const, key: "", limit: status.team.limit, spent: status.team.spent };
    }
    if (status.member.limit !== null && status.member.spent >= status.member.limit) {
      return { scope: "member" as const, key: "", limit: status.member.limit, spent: status.member.spent };
    }
    return null;
  }

  async function budgetBreach(session: Session) {
    const stored = await store.budgets.list();
    const name = session.repoRoot ? repoName(session.repoRoot) : null;
    const limits = effectiveLimits(config.budgets, stored, name);
    if (limits.length === 0) return teamBreach();
    const today = startOfToday(now());
    const spent = new Map<string, number>();
    for (const limit of limits) {
      if (limit.scope === "daily") spent.set("daily", await store.usage.spend({ since: today }));
      if (limit.scope === "session") spent.set("session", await store.usage.spend({ sessionId: session.id }));
      if (limit.scope === "repo" && session.repoId) {
        spent.set("repo", await store.usage.spend({ since: today, repoId: session.repoId }));
      }
    }
    return firstBreach(limits, (limit) => spent.get(limit.scope) ?? 0) ?? teamBreach();
  }

  return async function proxy(
    request: Request,
    sessionId: string,
    path: string,
    provider: Provider = "anthropic",
  ): Promise<Response> {
    // A ChatGPT sign-in is for ChatGPT's own backend; OpenAI's API would refuse it with a less helpful message.
    if (
      provider === "openai" &&
      upstreams.openai.hostname === "api.openai.com" &&
      request.headers.has("chatgpt-account-id")
    ) {
      return errorResponse(
        403,
        "permission_error",
        "Grenier sends OpenAI requests to OpenAI's API (proxy.upstream_openai), which takes an API key, not a ChatGPT sign-in. Sign Codex in with an API key (codex login --with-api-key), or run it without grenier run.",
      );
    }
    const session = await sessionFor(sessionId);
    const inference = request.method === "POST" && INFERENCE[provider].test(path);
    let body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const parsed = inference && body ? parseJson(body) : undefined;

    if (parsed) {
      const { loops: found, fresh } = await loops.observe(session.id, parsed, session.startedAt < startedAt);
      void recordSteps(session, fresh);
      await onLoops(session, found);
    }

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

    // Rule 9: the body changes only behind an opt-in flag, and every change is logged.
    if (
      provider === "anthropic" &&
      config.proxy.inject_cache_control &&
      parsed &&
      body &&
      !new TextDecoder().decode(body).includes('"cache_control"')
    ) {
      body = new TextEncoder().encode(JSON.stringify({ ...parsed, cache_control: { type: "ephemeral" } }))
        .buffer as ArrayBuffer;
      await store.events.add({
        sessionId: session.id,
        ts: now(),
        kind: "request_changed",
        detail: JSON.stringify({ change: "added top-level cache_control", reason: "proxy.inject_cache_control" }),
      });
    }

    const upstream = upstreams[provider];
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

    const contentType = response.headers.get("content-type");
    const reader = provider === "openai" ? new OpenAIUsageReader(contentType) : new UsageReader(contentType);
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
  messages?: { role?: string; content?: unknown; tool_calls?: unknown }[];
  input?: unknown;
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
