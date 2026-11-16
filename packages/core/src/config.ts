import { parse, TomlError } from "smol-toml";
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// An address that receives API keys or a team token: HTTPS, or plain HTTP to this machine (local test servers).
const secureUrl = z.url({ protocol: /^https?$/ }).refine(
  (value) => {
    const url = new URL(value);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  },
  { message: "must use https (http is only allowed for 127.0.0.1, localhost and [::1])" },
);

const perMillion = z.number().nonnegative();

/** USD per million tokens. `fast` multiplies every price when a response reports `speed: "fast"`. */
export const modelPriceSchema = z.strictObject({
  input: perMillion,
  output: perMillion,
  cache_write_5m: perMillion,
  cache_write_1h: perMillion,
  cache_read: perMillion,
  fast: z.number().positive().optional(),
  /** Prices once a request's input passes `threshold` tokens. */
  long_context: z
    .strictObject({
      threshold: z.int().positive(),
      input: perMillion,
      output: perMillion,
      cache_write_5m: perMillion,
      cache_write_1h: perMillion,
      cache_read: perMillion,
    })
    .optional(),
});

export type ModelPrice = z.output<typeof modelPriceSchema>;

const configSchema = z.strictObject({
  proxy: z
    .strictObject({
      port: z.int().min(1).max(65535).default(7788),
      upstream_anthropic: secureUrl.default("https://api.anthropic.com"),
      /** Adds a cache_control marker to requests that carry none. Off unless turned on; every change is logged. */
      inject_cache_control: z.boolean().default(false),
    })
    .prefault({}),
  budgets: z
    .strictObject({
      daily: z.number().positive().optional(),
      session: z.number().positive().optional(),
    })
    .prefault({}),
  guards: z
    .strictObject({
      loop_repeat_threshold: z.int().min(2).default(3),
      loop_window: z.int().min(2).default(10),
      on_loop: z.enum(["notify", "pause"]).default("notify"),
      /** Seconds a paused session's request waits for `grenier resume` before it is answered with an error. */
      pause_timeout: z.int().min(1).default(600),
    })
    .refine((guards) => guards.loop_repeat_threshold <= guards.loop_window, {
      message: "loop_repeat_threshold must not exceed loop_window",
      path: ["loop_repeat_threshold"],
    })
    .prefault({}),
  cache: z
    .strictObject({
      embeddings: z.enum(["local"]).default("local"),
      share_with_team: z.boolean().default(false),
    })
    .prefault({}),
  team: z
    .strictObject({
      url: z.union([z.literal(""), secureUrl]).default(""),
      token_env: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name, such as GRENIER_TEAM_TOKEN")
        .default("GRENIER_TEAM_TOKEN"),
    })
    .prefault({}),
  /** Overrides for packages/log/prices.toml, by model id. */
  prices: z.record(z.string(), modelPriceSchema).default({}),
});

export type Config = z.output<typeof configSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function defaultConfig(): Config {
  return configSchema.parse({});
}

/** Parses the text of a config.toml. `source` names the file in error messages. Throws a ConfigError. */
export function parseConfig(text: string, source: string): Config {
  return parseToml(text, source, configSchema);
}

/** Parses a prices.toml: a `[models."<id>"]` table per model. Throws a ConfigError. */
export function parsePrices(text: string, source: string): Record<string, ModelPrice> {
  return parseToml(text, source, pricesSchema).models;
}

const pricesSchema = z.strictObject({ models: z.record(z.string(), modelPriceSchema) });

function parseToml<T extends z.ZodType>(text: string, source: string, schema: T): z.output<T> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const reason = error.message.split("\n")[0]?.replace(/^Invalid TOML document: /, "");
      throw new ConfigError(`${source}:${error.line}:${error.column}: ${reason}`, { cause: error });
    }
    throw error;
  }

  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join(".");
    return key ? `  ${key}: ${issue.message}` : `  ${issue.message}`;
  });
  throw new ConfigError([`Invalid config in ${source}:`, ...lines].join("\n"));
}
