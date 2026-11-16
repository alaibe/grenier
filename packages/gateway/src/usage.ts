import type { TokenCounts } from "@grenier/log";

interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  speed?: string | null;
}

export interface ResponseUsage extends TokenCounts {
  model: string | null;
}

const MAX_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Reads a Messages API response as it passes through, without holding it back: the `message_start` and
 * `message_delta` events of a stream, or the `usage` of a JSON body. `push` takes each chunk as it is forwarded.
 */
export class UsageReader {
  readonly #streaming: boolean;
  readonly #decoder = new TextDecoder();
  #pending = "";
  #event = "";
  #data: string[] = [];
  #json: Uint8Array[] = [];
  #jsonBytes = 0;
  #model: string | null = null;
  #usage: AnthropicUsage = {};

  constructor(contentType: string | null) {
    this.#streaming = (contentType ?? "").includes("text/event-stream");
  }

  push(chunk: Uint8Array): void {
    if (!this.#streaming) {
      if (this.#jsonBytes + chunk.byteLength <= MAX_JSON_BYTES) this.#json.push(chunk);
      this.#jsonBytes += chunk.byteLength;
      return;
    }
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    let newline = this.#pending.indexOf("\n");
    while (newline !== -1) {
      this.#line(this.#pending.slice(0, newline).replace(/\r$/, ""));
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf("\n");
    }
  }

  /** What the response reported so far. Call it once the body has ended, or been cut off. */
  result(): ResponseUsage {
    if (this.#streaming) {
      if (this.#pending) this.#line(this.#pending);
      this.#line("");
    } else if (this.#jsonBytes <= MAX_JSON_BYTES) {
      this.#readJson();
    }
    const usage = this.#usage;
    return {
      model: this.#model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ...(usage.speed ? { speed: usage.speed } : {}),
    };
  }

  #line(line: string): void {
    if (line === "") {
      if (this.#data.length > 0) this.#dispatch(this.#event, this.#data.join("\n"));
      this.#event = "";
      this.#data = [];
    } else if (line.startsWith("event:")) {
      this.#event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      this.#data.push(line.slice(5).replace(/^ /, ""));
    }
  }

  #dispatch(event: string, data: string): void {
    if (event !== "message_start" && event !== "message_delta") return;
    let parsed: { message?: { model?: string; usage?: AnthropicUsage }; usage?: AnthropicUsage };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "message_start") {
      this.#model = parsed.message?.model ?? this.#model;
      this.#merge(parsed.message?.usage);
    } else {
      this.#merge(parsed.usage);
    }
  }

  #readJson(): void {
    const bytes = new Uint8Array(this.#jsonBytes);
    let offset = 0;
    for (const chunk of this.#json) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { model?: string; usage?: AnthropicUsage };
      this.#model = body.model ?? null;
      this.#merge(body.usage);
    } catch {
      // Not JSON, or cut off: there is no usage to read.
    }
  }

  /** Later events repeat or update counts (`message_delta` carries the final output_tokens): keep the latest. */
  #merge(usage: AnthropicUsage | undefined): void {
    if (!usage) return;
    for (const [key, value] of Object.entries(usage)) {
      if (value !== null && value !== undefined) (this.#usage as Record<string, unknown>)[key] = value;
    }
  }
}
