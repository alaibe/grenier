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
  messages?: { role?: string; content?: unknown }[];
}

/** Every tool_use in the conversation, and every tool_result marked as an error, keyed by its id, in order. */
export async function toolCalls(body: MessagesBody): Promise<{ key: string; call: ToolCall }[]> {
  const calls: { key: string; call: ToolCall }[] = [];
  for (const message of body.messages ?? []) {
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
