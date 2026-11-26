import { parse, TomlError } from "smol-toml";
import { z } from "zod";
import { DEVICE_NAME } from "./names.ts";

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

const rates = {
  input: perMillion,
  output: perMillion,
  cache_write_5m: perMillion,
  cache_write_1h: perMillion,
  cache_read: perMillion,
};

/** USD per million tokens. `fast` multiplies every price when a response reports `speed: "fast"`. */
const modelPriceSchema = z.strictObject({
  ...rates,
  fast: z.number().positive().optional(),
  /** Prices once a request's input passes `threshold` tokens. */
  long_context: z.strictObject({ threshold: z.int().positive(), ...rates }).optional(),
});

export type ModelPrice = z.output<typeof modelPriceSchema>;

const configSchema = z.strictObject({
  proxy: z
    .strictObject({
      port: z.int().min(1).max(65535).default(7788),
      upstream_anthropic: secureUrl.default("https://api.anthropic.com"),
      /** Where requests under /openai/ go: OpenAI, or any OpenAI-compatible API. */
      upstream_openai: secureUrl.default("https://api.openai.com"),
      /** Adds a cache_control marker to requests that carry none. Off unless turned on; every change is logged. */
      inject_cache_control: z.boolean().default(false),
    })
    .prefault({}),
  guards: z
    .strictObject({
      loop_repeat_threshold: z.int().min(2).default(3),
      loop_window: z.int().min(2).default(10),
      on_loop: z.enum(["notify", "pause"]).default("notify"),
      /** Seconds a paused session's request waits to be resumed before it is answered with an error. */
      pause_timeout: z.int().min(1).default(600),
    })
    .refine((guards) => guards.loop_repeat_threshold <= guards.loop_window, {
      message: "loop_repeat_threshold must not exceed loop_window",
      path: ["loop_repeat_threshold"],
    })
    .prefault({}),
  store: z
    .strictObject({
      /** "local" runs the embedding model on this machine; "off" leaves search to full text. */
      embeddings: z.enum(["local", "off"]).default("local"),
    })
    .prefault({}),
  team: z
    .strictObject({
      url: z.union([z.literal(""), secureUrl]).default(""),
      token_env: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name, such as GRENIER_TEAM_TOKEN")
        .default("GRENIER_TEAM_TOKEN"),
      /** Seconds between two rounds of sync with the team store; its live connection also starts one on each change. */
      sync_interval: z.int().min(1).max(3600).default(20),
    })
    .prefault({}),
  machine: z
    .strictObject({
      /** How the team sees this machine; its host name until set. */
      name: z.string().regex(DEVICE_NAME, "takes letters, digits and . _ -").optional(),
      /** The folder that holds this person's projects: every routine runs in it. */
      workdir: z.string().default(""),
      /** Whether this machine takes the team's routine runs. */
      routines: z.boolean().default(false),
      /** Runs only on mains power. */
      plugged_in: z.boolean().default(true),
      /** Minutes without keyboard or mouse before it is available; 0 for an always-on machine. */
      idle_minutes: z.int().min(0).default(10),
      /** CPU load per core and memory in use, as a share, above which it is not available. */
      cpu_max: z.number().min(0).max(1).default(0.5),
      memory_max: z.number().min(0).max(1).default(0.85),
      /** Hours it may run, as "22-7" (overnight) or "0-24". */
      hours: z
        .string()
        .regex(/^\d{1,2}-\d{1,2}$/, 'takes hours as "22-7"')
        .default("0-24"),
      agent: z.enum(["claude", "codex"]).default("claude"),
    })
    .prefault({}),
  retention: z
    .strictObject({
      /** Days each request's usage and the guards' events are kept; 0 keeps them for good. */
      usage_days: z.int().min(0).default(0),
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
  return validate(parseRaw(text, source), source, schema);
}

function parseRaw(text: string, source: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const reason = error.message.split("\n")[0]?.replace(/^Invalid TOML document: /, "");
      throw new ConfigError(`${source}:${error.line}:${error.column}: ${reason}`, { cause: error });
    }
    throw error;
  }
}

function validate<T extends z.ZodType>(raw: unknown, source: string, schema: T): z.output<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join(".");
    return key ? `  ${key}: ${issue.message}` : `  ${issue.message}`;
  });
  throw new ConfigError([`Invalid config in ${source}:`, ...lines].join("\n"));
}
