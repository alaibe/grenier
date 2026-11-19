import type { TokenCounts } from "@grenier/log";
import { BodyReader } from "./body.ts";

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

/** The usage of a Messages API response: the `message_start` and `message_delta` events of a stream, or a JSON body. */
export class UsageReader extends BodyReader<ResponseUsage> {
  #model: string | null = null;
  #usage: AnthropicUsage = {};

  protected onEvent(event: string, data: string): void {
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

  protected onJson(text: string): void {
    try {
      const body = JSON.parse(text) as { model?: string; usage?: AnthropicUsage };
      this.#model = body.model ?? null;
      this.#merge(body.usage);
    } catch {
      // Not JSON, or cut off: there is no usage to read.
    }
  }

  protected read(): ResponseUsage {
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

  /** Later events repeat or update counts (`message_delta` carries the final output_tokens): keep the latest. */
  #merge(usage: AnthropicUsage | undefined): void {
    if (!usage) return;
    for (const [key, value] of Object.entries(usage)) {
      if (value !== null && value !== undefined) (this.#usage as Record<string, unknown>)[key] = value;
    }
  }
}
