import { canonicalJson, sha256 } from "@grenier/core";

export interface ToolCall {
  /** The tool's name, or "error" for a failed tool result. */
  tool: string;
  hash: string;
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

/** Durations and times change from run to run of the same work, so they don't count. */
function steadyText(text: string): string {
  return (
    text
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
      // Not a file's line and column, as in `a.ts:12:34`: errors at other places are other errors.
      .replace(/(?<![\w.:])\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?![\w:])/g, "<time>")
      .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/g, "<duration>")
  );
}

/** A call is hashed with its result: the same call returning something else is progress, not a loop. */
export async function toolCalls(
  body: MessagesBody,
  seen: ReadonlySet<string> = new Set(),
): Promise<{ key: string; call: ToolCall }[]> {
  const calls: { key: string; call: ToolCall }[] = [];
  const results = resultsOf(body);
  const use = async (id: string | undefined, name: string | undefined, input: unknown) => {
    if (!id || seen.has(`use:${id}`)) return;
    const tool = name ?? "";
    const result = results.get(id);
    const returned = result ? `${result.error ? "error" : "ok"}\0${steadyText(result.text)}` : "";
    calls.push({
      key: `use:${id}`,
      call: { tool, hash: await sha256(`${tool}\0${canonicalJson(input)}\0${returned}`) },
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

/** A conversation is known by its first user message: subagents each have their own. */
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

/** Fires once a hash repeats `threshold` times in the last `window`, then forgets those repeats. */
export class LoopDetector {
  #recent: string[] = [];

  constructor(
    readonly threshold: number,
    readonly window: number,
  ) {}

  observe(hash: string): boolean {
    this.#recent.push(hash);
    if (this.#recent.length > this.window) this.#recent.shift();

    if (this.count(hash) < this.threshold) return false;
    this.#recent = this.#recent.filter((seen) => seen !== hash);
    return true;
  }

  count(hash: string): number {
    return this.#recent.filter((seen) => seen === hash).length;
  }
}

export const IDLE_SESSION = 6 * 60 * 60 * 1000;
const SWEEP_EVERY = 60 * 1000;

/** A session older than this process, or back from idle, only marks the history it resends as seen. */
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

  /** The calls in this request that complete a loop. */
  async observe(sessionId: string, body: MessagesBody, startedBeforeUs: boolean): Promise<ToolCall[]> {
    const now = this.now();
    this.#sweep(now);
    const conversation = `${sessionId}\0${await conversationOf(body)}`;
    let state = this.#sessions.get(conversation);
    let counting = true;
    if (!state) {
      const returning = this.#dropped.delete(conversation);
      state = { seen: new Set(), detector: new LoopDetector(this.threshold, this.window), at: now };
      this.#sessions.set(conversation, state);
      counting = !startedBeforeUs && !returning;
    }
    state.at = now;
    const loops: ToolCall[] = [];
    for (const { key, call } of await toolCalls(body, state.seen)) {
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      if (counting && state.detector.observe(call.hash)) loops.push(call);
    }
    return loops;
  }

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
