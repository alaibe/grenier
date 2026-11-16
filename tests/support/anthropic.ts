import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** A streamed Messages API response holding one content block, as a stand-in for the API sends it. */
export function messageStream(model: string, block: Block, inputTokens = 25): string {
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const [start, delta] =
    block.type === "text"
      ? [
          { type: "text", text: "" },
          { type: "text_delta", text: block.text },
        ]
      : [
          { type: "tool_use", id: block.id, name: block.name, input: {} },
          { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        ];
  return [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_stand_in",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: start }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
