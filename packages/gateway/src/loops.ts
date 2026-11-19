import { canonicalJson, LoopDetector, sha256 } from "@grenier/core";

export interface ToolCall {
  /** The tool's name, or "error" for a failed tool result. */
  tool: string;
  hash: string;
}

/** A call with what it was given and, when the request carries it, what it returned. */
export interface ToolUse {
  id: string;
  tool: string;
  input: unknown;
  result?: { error: boolean; text: string };
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface MessagesBody {
  messages?: { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }[];
  /** OpenAI's Responses API: the conversation as items. */
  input?: unknown;
}

interface OpenAIItem {
  id?: string;
  call_id?: string;
  type?: string;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  action?: unknown;
  output?: unknown;
  function?: { name?: string; arguments?: unknown };
}

/** OpenAI sends a call's arguments as a JSON string; equal arguments in another key order are the same call. */
function argumentsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("\n");
}

/** What each call returned, by call id. */
function resultsOf(body: MessagesBody): Map<string, { error: boolean; text: string }> {
  const results = new Map<string, { error: boolean; text: string }>();
  for (const message of body.messages ?? []) {
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      results.set(message.tool_call_id, { error: false, text: textOf(message.content) });
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Block[]) {
      if (block.type === "tool_result" && block.tool_use_id) {
        results.set(block.tool_use_id, { error: block.is_error === true, text: textOf(block.content) });
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input as OpenAIItem[]) {
      if (item.type?.endsWith("_call_output") && item.call_id) {
        results.set(item.call_id, { error: false, text: textOf(item.output) });
      }
    }
  }
  return results;
}

/** A result without what changes from run to run of the same work: durations, clock times and timestamps. */
function steadyText(text: string): string {
  return (
    text
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
      // Not a file's line and column, as in `a.ts:12:34`: errors at other places are other errors.
      .replace(/(?<![\w.:])\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?![\w:])/g, "<time>")
      .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/g, "<duration>")
  );
}

/**
 * Every tool call in the conversation, keyed by its id, in order: Anthropic's tool_use blocks and tool_result blocks
 * marked as errors, OpenAI's Chat Completions tool_calls and Responses function, custom tool and shell call items.
 * A call is hashed with its result, when the request carries it: the same call returning something else is progress,
 * not a loop. Calls whose key is in `seen` are left out before they are hashed: each request resends the whole
 * conversation.
 */
export async function toolCalls(
  body: MessagesBody,
  seen: ReadonlySet<string> = new Set(),
): Promise<{ key: string; call: ToolCall; use?: ToolUse }[]> {
  const calls: { key: string; call: ToolCall; use?: ToolUse }[] = [];
  const results = resultsOf(body);
  const use = async (id: string | undefined, name: string | undefined, input: unknown) => {
    if (!id || seen.has(`use:${id}`)) return;
    const tool = name ?? "";
    const result = results.get(id);
    const returned = result ? `${result.error ? "error" : "ok"}\0${steadyText(result.text)}` : "";
    calls.push({
      key: `use:${id}`,
      call: { tool, hash: await sha256(`${tool}\0${canonicalJson(input)}\0${returned}`) },
      use: { id, tool, input, ...(result ? { result } : {}) },
    });
  };
  for (const message of body.messages ?? []) {
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as OpenAIItem[])
        await use(call.id, call.function?.name, argumentsOf(call.function?.arguments));
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Block[]) {
      if (block.type === "tool_use" && block.id) {
        await use(block.id, block.name, block.input);
      } else if (block.type === "tool_result" && block.is_error && block.tool_use_id) {
        if (seen.has(`error:${block.tool_use_id}`)) continue;
        calls.push({
          key: `error:${block.tool_use_id}`,
          call: { tool: "error", hash: await sha256(`error\0${canonicalJson(block.content)}`) },
        });
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input as OpenAIItem[]) {
      const id = item.call_id ?? item.id;
      if (item.type === "function_call") await use(id, item.name, argumentsOf(item.arguments));
      else if (item.type === "custom_tool_call") await use(id, item.name, item.input);
      else if (item.type === "local_shell_call") await use(id, "local_shell", item.action);
    }
  }
  return calls;
}

/** Which conversation of a session a request belongs to: its first user message. Subagents each have their own. */
async function conversationOf(body: MessagesBody): Promise<string> {
  const first =
    body.messages?.find((message) => message.role === "user") ??
    (Array.isArray(body.input)
      ? ((body.input as { role?: string }[]).find((item) => item?.role === "user") ?? body.input[0])
      : body.input);
  // Its text only: an agent moves cache markers between requests, and the conversation stays the same.
  const content = first && typeof first === "object" && "content" in first ? first.content : first;
  return sha256(textOf(content) || canonicalJson(content ?? null));
}

/** How long a session may go without a request before its state is dropped. */
export const IDLE_SESSION = 6 * 60 * 60 * 1000;
const SWEEP_EVERY = 60 * 1000;

/**
 * The tool calls each conversation of each session has made, across its requests. Each request resends the whole
 * conversation, so only calls not seen before are observed. For a session that started before this process (the daemon restarted under
 * it), the first request only marks what it carries as seen, so old history is not counted twice as a loop. A
 * session idle for `idle` is dropped; when it comes back, its history is marked as seen again, neither counted nor
 * returned as fresh, since it was both when it was first seen.
 */
export class LoopWatch {
  readonly #sessions = new Map<string, { seen: Set<string>; detector: LoopDetector; at: number }>();
  readonly #dropped = new Set<string>();
  #swept = 0;

  constructor(
    readonly threshold: number,
    readonly window: number,
    readonly now: () => number = Date.now,
    readonly idle = IDLE_SESSION,
  ) {}

  /** The calls in this request that complete a loop, and every call this process had not seen yet. */
  async observe(
    sessionId: string,
    body: MessagesBody,
    startedBeforeUs: boolean,
  ): Promise<{ loops: ToolCall[]; fresh: ToolUse[] }> {
    const now = this.now();
    this.#sweep(now);
    const conversation = `${sessionId}\0${await conversationOf(body)}`;
    let state = this.#sessions.get(conversation);
    let counting = true;
    let recording = true;
    if (!state) {
      const returning = this.#dropped.delete(conversation);
      state = { seen: new Set(), detector: new LoopDetector(this.threshold, this.window), at: now };
      this.#sessions.set(conversation, state);
      counting = !startedBeforeUs && !returning;
      recording = !returning;
    }
    state.at = now;
    const loops: ToolCall[] = [];
    const fresh: ToolUse[] = [];
    for (const { key, call, use } of await toolCalls(body, state.seen)) {
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      if (use && recording) fresh.push(use);
      if (counting && state.detector.observe(call.hash)) loops.push(call);
    }
    return { loops, fresh };
  }

  /** How many conversations are held in memory. */
  get size(): number {
    return this.#sessions.size;
  }

  #sweep(now: number): void {
    if (now - this.#swept < SWEEP_EVERY) return;
    this.#swept = now;
    for (const [id, state] of this.#sessions) {
      if (now - state.at <= this.idle) continue;
      this.#sessions.delete(id);
      this.#dropped.add(id);
    }
  }
}
