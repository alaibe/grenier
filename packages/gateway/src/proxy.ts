import type { Config } from "@grenier/core";
import { costOf, type Prices, priceOf } from "@grenier/log";
import type { Session, Store } from "@grenier/store";
import { LoopWatch, type ToolCall } from "./loops.ts";
import { OpenAIUsageReader } from "./openai.ts";
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
  notify?: (title: string, message: string) => void;
  log?: (line: string) => void;
  /** How often a held request looks for its session resumed, in milliseconds. */
  pollInterval?: number;
  /** When this process started: sessions older than it get their history marked as seen, not counted. */
  startedAt?: number;
  /** For a session that is a routine's run: what it may call, and the wait while the machine's person is back. */
  runGuard?: (session: Session) => Promise<RunGuard | null>;
}

/** What the proxy enforces on a routine's run, whatever the agent was told. */
export interface RunGuard {
  /** Whether a tool call may go through; a refused one cuts the answer off before it and ends the run. */
  allows(tool: string): boolean;
  cut(tool: string): void;
  /** True once the run may make its next model call; false when it must stop. */
  hold(signal: AbortSignal): Promise<boolean>;
}

const cutMessage = (tool: string) => `Grenier cut this routine's run off: it may not call ${tool}.`;

/** An item of OpenAI's Responses API. */
interface ResponseItem {
  id?: string;
  call_id?: string;
  type?: string;
  name?: string;
  namespace?: string;
}

const CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

/** The tool a Responses item calls, named as Codex names it: an MCP tool's namespace and name joined by "__". */
function calledTool(item: ResponseItem): string | null {
  if (!item.type || !CALLS.has(item.type)) return null;
  if (item.type === "local_shell_call") return "local_shell";
  const name = item.name ?? "";
  return item.namespace ? `${item.namespace.replace(/_+$/, "")}__${name.replace(/^_+/, "")}` : name;
}

/** The tools a whole answer calls. */
function toolsOfAnswer(provider: Provider, bytes: Uint8Array): string[] {
  try {
    const answer = JSON.parse(new TextDecoder().decode(bytes)) as {
      content?: { type?: string; name?: string }[];
      output?: ResponseItem[];
    };
    if (provider === "anthropic") {
      return (answer.content ?? []).filter((block) => block.type === "tool_use").map((block) => block.name ?? "");
    }
    return (answer.output ?? []).map(calledTool).filter((tool) => tool !== null);
  } catch {
    // Not a message: passed back as it came.
    return [];
  }
}

/** The tool a stream's event starts a call to, each call once, or null. */
function streamedTools(provider: Provider): (data: string) => string | null {
  const seen = new Set<string>();
  return (data) => {
    try {
      if (provider === "anthropic") {
        if (!data.includes('"tool_use"')) return null;
        const event = JSON.parse(data) as { type?: string; content_block?: { type?: string; name?: string } };
        if (event.type !== "content_block_start" || event.content_block?.type !== "tool_use") return null;
        return event.content_block.name ?? "";
      }
      // A call shows in output_item.added, and again in .done: either may be the first one seen.
      if (!data.includes('"response.output_item.')) return null;
      const event = JSON.parse(data) as { type?: string; output_index?: number; item?: ResponseItem };
      if (!event.item || !/^response\.output_item\.(added|done)$/.test(event.type ?? "")) return null;
      const tool = calledTool(event.item);
      const key = event.item.id ?? event.item.call_id ?? String(event.output_index);
      if (tool === null || seen.has(key)) return null;
      seen.add(key);
      return tool;
    } catch {
      // Not JSON: passed through like any other line.
      return null;
    }
  };
}

/** The stream's last event once a run is cut off, as each API ends a stream that failed. */
function cutEvent(provider: Provider, tool: string): string {
  if (provider === "anthropic") {
    const error = { type: "error", error: { type: "permission_error", message: cutMessage(tool) } };
    return `event: error\ndata: ${JSON.stringify(error)}\n\n`;
  }
  const failed = {
    type: "response.failed",
    response: { status: "failed", error: { code: "permission_error", message: cutMessage(tool) } },
  };
  return `event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`;
}

/** From the first refused tool call on, the stream becomes one error event and the upstream is cancelled. */
function guardedEvents(guard: RunGuard, provider: Provider) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const toolIn = streamedTools(provider);
  let pending = "";
  return (chunk: Uint8Array | null): { out: Uint8Array | null; stop: boolean } => {
    pending += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    const end = chunk ? pending.lastIndexOf("\n\n") : pending.length;
    if (end < 0) return { out: null, stop: false };
    const complete = pending.slice(0, chunk ? end + 2 : end);
    pending = pending.slice(complete.length);
    let passed = "";
    for (const event of complete.split(/(?<=\n\n)/)) {
      const data = /^data: ?(.*)$/m.exec(event)?.[1];
      const tool = data === undefined ? null : toolIn(data);
      if (tool !== null && !guard.allows(tool)) {
        guard.cut(tool);
        return { out: encoder.encode(passed + cutEvent(provider, tool)), stop: true };
      }
      passed += event;
    }
    return { out: passed ? encoder.encode(passed) : null, stop: false };
  };
}

// Hop-by-hop headers, and the ones fetch sets itself.
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
        notify("Grenier paused a session", `${repeated}. Resume it on Grenier's Cost screen.`);
      } else {
        notify("Grenier: possible loop", `${repeated} (session ${session.id}).`);
      }
    }
  }

  /** False when the pause outlasted the timeout or the client went away. */
  async function waitWhilePaused(id: string, signal: AbortSignal): Promise<boolean> {
    const deadline = now() + config.guards.pause_timeout * 1000;
    while ((await store.sessions.get(id))?.paused) {
      if (signal.aborted || now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    return true;
  }

  const unpricedSeen = new Set<string>();

  /** Says once, ever, that a model has no price, so its requests count as $0. */
  async function sawUnpriced(session: Session, model: string) {
    if (unpricedSeen.has(model)) return;
    unpricedSeen.add(model);
    const earlier = await store.events.list({ kind: "unpriced" });
    if (earlier.some((event) => event.detail === JSON.stringify({ model }))) return;
    await store.events.add({ sessionId: session.id, ts: now(), kind: "unpriced", detail: JSON.stringify({ model }) });
    notify("Grenier: a model with no price", `${model} has no price in prices.toml: its requests count as $0.`);
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
      await onLoops(session, await loops.observe(session.id, parsed, session.startedAt < startedAt));
    }

    if (!(await waitWhilePaused(session.id, request.signal))) {
      return errorResponse(
        429,
        "rate_limit_error",
        `Grenier paused this session after a possible loop. To let it continue, resume it on Grenier's Cost screen.`,
      );
    }

    const guard = (await options.runGuard?.(session)) ?? null;
    if (guard && !(await guard.hold(request.signal))) {
      return errorResponse(
        529,
        "overloaded_error",
        "Grenier stopped this routine's run: the machine is no longer available, or the run was cut off. Its task goes back to the team.",
      );
    }

    const requestedModel = typeof parsed?.model === "string" ? parsed.model : null;
    if (inference && requestedModel !== null && priceOf(requestedModel, prices) === null) {
      await sawUnpriced(session, requestedModel);
    }

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
      return errorResponse(502, "api_error", `Grenier could not reach ${target.host}: ${(error as Error).message}`);
    }

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
    let recorded = false;
    // However the body ends (all read, cut off by the upstream, or dropped by the client), its usage is written once.
    const record = () => {
      if (recorded) return Promise.resolve();
      recorded = true;
      return (async () => {
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
        }
      })();
    };
    request.signal.addEventListener("abort", () => void record(), { once: true });

    const streamed = (contentType ?? "").includes("text/event-stream");
    // A whole answer, not a stream: its tool calls are checked before any of it goes back.
    if (guard && !streamed) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      reader.push(bytes);
      await record();
      for (const tool of toolsOfAnswer(provider, bytes)) {
        if (guard.allows(tool)) continue;
        guard.cut(tool);
        return errorResponse(403, "permission_error", cutMessage(tool));
      }
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    const source = response.body.getReader();
    const filter = guard && streamed ? guardedEvents(guard, provider) : null;
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
          const rest = filter?.(null);
          if (rest?.out) controller.enqueue(rest.out);
          await record();
          controller.close();
          return;
        }
        reader.push(chunk.value);
        if (!filter) {
          controller.enqueue(chunk.value);
          return;
        }
        const { out, stop } = filter(chunk.value);
        if (out) controller.enqueue(out);
        if (stop) {
          await record();
          controller.close();
          await source.cancel().catch(() => undefined);
        }
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
