import { canonicalJson, LoopDetector, sha256 } from "@grenier/core";

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
  messages?: { role?: string; content?: unknown; tool_calls?: unknown }[];
  /** OpenAI's Responses API: the conversation as items. */
  input?: unknown;
}

interface OpenAIToolCall {
  id?: string;
  call_id?: string;
  type?: string;
  name?: string;
  arguments?: unknown;
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

/**
 * Every tool call in the conversation, keyed by its id, in order: Anthropic's tool_use blocks and tool_result blocks
 * marked as errors, OpenAI's Chat Completions tool_calls and Responses function_call items.
 */
export async function toolCalls(body: MessagesBody): Promise<{ key: string; call: ToolCall }[]> {
  const calls: { key: string; call: ToolCall }[] = [];
  const openai = async (id: string | undefined, name: string | undefined, args: unknown) => {
    if (!id) return;
    const tool = name ?? "";
    calls.push({
      key: `use:${id}`,
      call: { tool, hash: await sha256(`${tool}\0${canonicalJson(argumentsOf(args))}`) },
    });
  };
  for (const message of body.messages ?? []) {
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as OpenAIToolCall[])
        await openai(call.id, call.function?.name, call.function?.arguments);
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Block[]) {
      if (block.type === "tool_use" && block.id) {
        const tool = block.name ?? "";
        calls.push({
          key: `use:${block.id}`,
          call: { tool, hash: await sha256(`${tool}\0${canonicalJson(block.input)}`) },
        });
      } else if (block.type === "tool_result" && block.is_error && block.tool_use_id) {
        calls.push({
          key: `error:${block.tool_use_id}`,
          call: { tool: "error", hash: await sha256(`error\0${canonicalJson(block.content)}`) },
        });
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input as OpenAIToolCall[]) {
      if (item.type === "function_call") await openai(item.call_id ?? item.id, item.name, item.arguments);
    }
  }
  return calls;
}

/**
 * The tool calls each session has made, across its requests. Each request resends the whole conversation, so only
 * calls not seen before are observed. For a session that started before this process (the daemon restarted under
 * it), the first request only marks what it carries as seen, so old history is not counted twice.
 */
export class LoopWatch {
  readonly #sessions = new Map<string, { seen: Set<string>; detector: LoopDetector }>();

  constructor(
    readonly threshold: number,
    readonly window: number,
  ) {}

  /** The calls in this request that complete a loop. */
  async observe(sessionId: string, body: MessagesBody, startedBeforeUs: boolean): Promise<ToolCall[]> {
    const calls = await toolCalls(body);
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { seen: new Set(), detector: new LoopDetector(this.threshold, this.window) };
      this.#sessions.set(sessionId, state);
      if (startedBeforeUs) {
        for (const { key } of calls) state.seen.add(key);
        return [];
      }
    }
    const loops: ToolCall[] = [];
    for (const { key, call } of calls) {
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      if (state.detector.observe(call.hash)) loops.push(call);
    }
    return loops;
  }
}
