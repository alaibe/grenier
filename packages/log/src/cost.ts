import { type ModelPrice, parsePrices } from "@grenier/core";
import pricesToml from "../prices.toml";

export type Prices = Readonly<Record<string, ModelPrice>>;

/** The prices shipped in packages/log/prices.toml, with the config file's `[prices]` laid over them. */
export function loadPrices(overrides: Prices = {}): Prices {
  return { ...parsePrices(pricesToml, "packages/log/prices.toml"), ...overrides };
}

/** The four token counts a response reports, as Anthropic's `usage` names them in short. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** All cache writes, whatever their lifetime. */
  cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` written with the 1-hour lifetime. */
  cacheWrite1hTokens?: number;
  speed?: string;
}

/**
 * The price entry for a model id: the exact id, else the id without a trailing variant such as `[1m]` or a trailing
 * date, else null.
 */
export function priceOf(model: string, prices: Prices): ModelPrice | null {
  const base = model.replace(/\[[^\]]*\]$/, "");
  return prices[model] ?? prices[base] ?? prices[base.replace(/-\d{8}$/, "")] ?? null;
}

/** What a response cost in USD, or null for a model with no price. */
export function costOf(model: string | null, usage: TokenCounts, prices: Prices): number | null {
  const price = model === null ? null : priceOf(model, prices);
  if (price === null) return null;

  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const rates = price.long_context && input > price.long_context.threshold ? price.long_context : price;
  const write1h = Math.min(usage.cacheWrite1hTokens ?? 0, usage.cacheWriteTokens);
  const write5m = usage.cacheWriteTokens - write1h;
  const multiplier = usage.speed === "fast" ? (price.fast ?? 1) : 1;

  const dollars =
    usage.inputTokens * rates.input +
    usage.outputTokens * rates.output +
    usage.cacheReadTokens * rates.cache_read +
    write5m * rates.cache_write_5m +
    write1h * rates.cache_write_1h;
  return (dollars * multiplier) / 1_000_000;
}

/** What prompt-cache reads saved against paying full input price for the same tokens, in USD. */
export function cacheSavingsOf(model: string | null, cacheReadTokens: number, prices: Prices): number {
  const price = model === null ? null : priceOf(model, prices);
  if (price === null) return 0;
  return (cacheReadTokens * (price.input - price.cache_read)) / 1_000_000;
}
