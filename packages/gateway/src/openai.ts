import type { ResponseUsage } from "./usage.ts";

interface OpenAIUsage {
  // Chat Completions
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  // Responses
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

const MAX_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Reads the usage of an OpenAI response as it passes through: Chat Completions (a JSON body, or the last chunk of a
 * stream when the client asked for `stream_options.include_usage`) and the Responses API (`response.completed`).
 * OpenAI counts cached input inside the input total; it is moved to `cacheReadTokens` here.
 */
export class OpenAIUsageReader {
  readonly #streaming: boolean;
  readonly #decoder = new TextDecoder();
  #pending = "";
  #data: string[] = [];
  #json: Uint8Array[] = [];
  #jsonBytes = 0;
  #model: string | null = null;
  #usage: OpenAIUsage | null = null;

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

  result(): ResponseUsage {
    if (this.#streaming) {
      if (this.#pending) this.#line(this.#pending);
      this.#line("");
    } else if (this.#jsonBytes <= MAX_JSON_BYTES) {
      const bytes = new Uint8Array(this.#jsonBytes);
      let offset = 0;
      for (const chunk of this.#json) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.#read(new TextDecoder().decode(bytes));
    }
    const usage = this.#usage ?? {};
    const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
    return {
      model: this.#model,
      inputTokens: Math.max(0, input - cached),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    };
  }

  #line(line: string): void {
    if (line === "") {
      if (this.#data.length > 0) this.#read(this.#data.join("\n"));
      this.#data = [];
    } else if (line.startsWith("data:")) {
      this.#data.push(line.slice(5).replace(/^ /, ""));
    }
  }

  #read(text: string): void {
    if (text.trim() === "[DONE]") return;
    let value: {
      model?: string;
      usage?: OpenAIUsage | null;
      response?: { model?: string; usage?: OpenAIUsage | null };
    };
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const model = value.response?.model ?? value.model;
    if (model) this.#model = model;
    const usage = value.response?.usage ?? value.usage;
    if (usage) this.#usage = usage;
  }
}
