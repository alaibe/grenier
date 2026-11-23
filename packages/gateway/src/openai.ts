import { BodyReader } from "./body.ts";
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

/** OpenAI counts cached input inside the input total; it is moved to `cacheReadTokens` here. */
export class OpenAIUsageReader extends BodyReader<ResponseUsage> {
  #model: string | null = null;
  #usage: OpenAIUsage | null = null;

  protected onEvent(_event: string, data: string): void {
    this.onJson(data);
  }

  protected onJson(text: string): void {
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

  protected read(): ResponseUsage {
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
}
