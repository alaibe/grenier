import {
  type BudgetLimit,
  budgetMessage,
  type Config,
  effectiveLimits,
  firstBreach,
  limitsNear,
  unpricedMessage,
  WARN_AT,
  warningMessage,
} from "@grenier/core";
import { costOf, type Prices, priceOf, projectOf, startOfToday } from "@grenier/log";
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

/** What a request let through is expected to cost, held against the limits until its usage row is written. */
interface Reservation {
  sessionId: string;
  project: string | null;
  amount: number;
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
  const log = options.log ?? (() => {});
  const pollInterval = options.pollInterval ?? 500;
  const startedAt = options.startedAt ?? now();
  const loops = new LoopWatch(config.guards.loop_repeat_threshold, config.guards.loop_window, now);
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
      if (config.guards.on_loop === "pause" && session.id !== UNTAGGED) {
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

  const reservations = new Set<Reservation>();
  const warned = new Set<string>();
  const unpricedSeen = new Set<string>();
  // Budget checks and usage writes run one at a time, so requests in flight are always counted.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function reserved(limit: BudgetLimit, session: Session, project: string | null): number {
    let total = 0;
    for (const reservation of reservations) {
      if (
        limit.scope === "daily" ||
        (limit.scope === "session" && reservation.sessionId === session.id) ||
        (limit.scope === "repo" && reservation.project === project)
      ) {
        total += reservation.amount;
      }
    }
    return total;
  }

  async function warnNear(session: Session, limits: readonly BudgetLimit[], spent: (limit: BudgetLimit) => number) {
    const day = startOfToday(now());
    for (const near of limitsNear(limits, spent, WARN_AT)) {
      const key = `${near.scope}:${near.scope === "session" ? session.id : near.key}:${day}`;
      if (warned.has(key)) continue;
      warned.add(key);
      await store.events.add({
        sessionId: session.id,
        ts: now(),
        kind: "budget_warning",
        detail: JSON.stringify(near),
      });
      notify("Grenier: 80% of a budget", warningMessage(near));
    }
  }

  /** Says once, ever, that a model has no price, so its requests count as $0. */
  async function sawUnpriced(session: Session, model: string) {
    if (unpricedSeen.has(model)) return;
    unpricedSeen.add(model);
    const earlier = await store.events.list({ kind: "unpriced" });
    if (earlier.some((event) => event.detail === JSON.stringify({ model }))) return;
    await store.events.add({ sessionId: session.id, ts: now(), kind: "unpriced", detail: JSON.stringify({ model }) });
    notify("Grenier: a model with no price", `${model} has no price in prices.toml: its requests count as $0.`);
  }

  type Admission = { refused: Response; reservation?: undefined } | { refused?: undefined; reservation: Reservation };

  /**
   * Lets a request through with a reservation of what it is expected to cost (the session's last request that cost
   * something), or refuses it: a limit is reached, the request would pass one, or its model has no price.
   */
  function admit(session: Session, model: string | null, next: number): Promise<Admission> {
    return serial(async () => {
      const project = projectOf(session);
      const limits = effectiveLimits(config.budgets, await store.budgets.list(), project);
      const today = startOfToday(now());
      const stored = new Map<string, number>();
      for (const limit of limits) {
        if (limit.scope === "daily") stored.set("daily", await store.usage.spend({ since: today }));
        if (limit.scope === "session") stored.set("session", await store.usage.spend({ sessionId: session.id }));
        if (limit.scope === "repo") {
          const folders = (await store.usage.spendByFolder(today)).filter((folder) => projectOf(folder) === project);
          stored.set(
            "repo",
            folders.reduce((total, folder) => total + folder.spent, 0),
          );
        }
      }
      const spent = (limit: BudgetLimit) => (stored.get(limit.scope) ?? 0) + reserved(limit, session, project);
      const breach = firstBreach(limits, spent, next);
      if (breach) return { refused: await refuse(session, breach, budgetMessage(breach)) };
      const unpriced = model !== null && priceOf(model, prices) === null;
      const first = limits[0] ?? teamLimits(teamStatus?.value)[0];
      if (unpriced && first && config.budgets.unpriced === "block") {
        return { refused: await refuse(session, { ...first, model, unpriced: true }, unpricedMessage(model, first)) };
      }
      if (unpriced) await sawUnpriced(session, model);
      await warnNear(session, limits, spent);
      const reservation = { sessionId: session.id, project, amount: next };
      reservations.add(reservation);
      return { reservation };
    });
  }

  async function refuse(session: Session, detail: unknown, message: string): Promise<Response> {
    await store.events.add({ sessionId: session.id, ts: now(), kind: "budget", detail: JSON.stringify(detail) });
    return errorResponse(429, "rate_limit_error", message);
  }

  type TeamStatus = Awaited<ReturnType<NonNullable<ProxyOptions["teamBudget"]>>>;
  function teamLimits(status: TeamStatus | undefined): BudgetLimit[] {
    const limits: BudgetLimit[] = [];
    if (status?.team.limit != null) limits.push({ scope: "team", key: "", limit: status.team.limit });
    if (status?.member.limit != null) limits.push({ scope: "member", key: "", limit: status.member.limit });
    return limits;
  }

  let teamStatus: { at: number; value: TeamStatus } | undefined;
  async function teamBreach(next: number) {
    if (!options.teamBudget) return null;
    if (!teamStatus || now() - teamStatus.at > TEAM_BUDGET_TTL) {
      // A team server that cannot be reached does not stop anyone's work: the request goes through.
      teamStatus = { at: now(), value: await options.teamBudget().catch(() => null) };
    }
    const status = teamStatus.value;
    if (!status) return null;
    const spent = (limit: BudgetLimit) => (limit.scope === "team" ? status.team.spent : status.member.spent);
    return firstBreach(teamLimits(status), spent, next);
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

    const requestedModel = typeof parsed?.model === "string" ? parsed.model : null;
    let reservation: Reservation | undefined;
    if (inference) {
      const next = (await store.usage.lastCost(session.id)) ?? 0;
      const team = await teamBreach(next);
      if (team) return refuse(session, team, budgetMessage(team));
      const admission = await admit(session, requestedModel, next);
      if (admission.refused) return admission.refused;
      reservation = admission.reservation;
    }
    const release = () => {
      if (reservation) reservations.delete(reservation);
    };

    // The body changes only behind an opt-in flag, and every change is logged.
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

    let response: Response;
    try {
      response = await fetchUpstream(target, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: request.signal,
        redirect: "manual",
      });
    } catch (error) {
      release();
      return errorResponse(502, "api_error", `Grenier could not reach ${target.host}: ${(error as Error).message}`);
    }

    const responseHeaders = new Headers();
    for (const [name, value] of response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.append(name, value);
    }
    if (!inference || !response.body) {
      release();
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    const contentType = response.headers.get("content-type");
    const reader = provider === "openai" ? new OpenAIUsageReader(contentType) : new UsageReader(contentType);
    let recorded = false;
    // However the body ends (all read, cut off by the upstream, or dropped by the client), its usage is written once.
    const record = () => {
      if (recorded) return Promise.resolve();
      recorded = true;
      return serial(async () => {
        try {
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
        } catch (error) {
          log(`grenier: could not record the usage of session ${session.id}: ${(error as Error).message}`);
        } finally {
          release();
        }
      });
    };
    request.signal.addEventListener("abort", () => void record(), { once: true });

    const source = response.body.getReader();
    const tapped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof source.read>>;
        try {
          chunk = await source.read();
        } catch (error) {
          await record();
          controller.error(error);
          return;
        }
        if (chunk.done) {
          await record();
          controller.close();
          return;
        }
        reader.push(chunk.value);
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        await record();
        await source.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(tapped, {
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
