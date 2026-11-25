import { ConfigError, defaultConfig, parseConfig, parsePrices } from "@grenier/core";
import { describe, expect, it } from "vitest";

const EXAMPLE = `
[proxy]
port = 7788
upstream_anthropic = "https://api.anthropic.com"

[guards]
loop_repeat_threshold = 3
loop_window = 10
on_loop = "notify"

[store]
embeddings = "local"

[machine]
name = "build-mini"
routines = true
idle_minutes = 0
hours = "22-7"

[team]
url = ""
token_env = "GRENIER_TEAM_TOKEN"
`;

function errorOf(text: string): ConfigError {
  try {
    parseConfig(text, "config.toml");
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected parseConfig to throw a ConfigError");
}

describe("defaultConfig", () => {
  it("fills every section with its defaults", () => {
    expect(defaultConfig()).toEqual({
      proxy: {
        port: 7788,
        upstream_anthropic: "https://api.anthropic.com",
        upstream_openai: "https://api.openai.com",
        inject_cache_control: false,
      },
      guards: { loop_repeat_threshold: 3, loop_window: 10, on_loop: "notify", pause_timeout: 600 },
      store: { embeddings: "local" },
      team: { url: "", token_env: "GRENIER_TEAM_TOKEN", sync_interval: 20 },
      machine: {
        workdir: "",
        routines: false,
        plugged_in: true,
        idle_minutes: 10,
        cpu_max: 0.5,
        memory_max: 0.85,
        hours: "0-24",
        agent: "claude",
      },
      retention: { usage_days: 0 },
      prices: {},
    });
  });
});

describe("parseConfig", () => {
  it("reads a full example config", () => {
    const config = parseConfig(EXAMPLE, "config.toml");
    expect(config.store.embeddings).toBe("local");
    expect(config.machine).toMatchObject({ name: "build-mini", routines: true, idle_minutes: 0, hours: "22-7" });
    expect(config.guards.on_loop).toBe("notify");
  });

  it("refuses a machine name or hours it cannot use", () => {
    expect(errorOf('[machine]\nname = "my mac"\n').message).toContain("machine.name:");
    expect(errorOf('[machine]\nhours = "nights"\n').message).toContain("machine.hours:");
  });

  it("allows plain http to a loopback upstream", () => {
    const config = parseConfig('[proxy]\nupstream_anthropic = "http://127.0.0.1:9999"\n', "config.toml");
    expect(config.proxy.upstream_anthropic).toBe("http://127.0.0.1:9999");
  });

  it("names an unknown key, so a typo does not pass silently", () => {
    expect(errorOf("[proxi]\nport = 1\n").message).toBe('Invalid config in config.toml:\n  Unrecognized key: "proxi"');
    expect(errorOf("[proxy]\nprot = 1\n").message).toContain('proxy: Unrecognized key: "prot"');
  });

  it("refuses an upstream that would receive API keys over plain http", () => {
    expect(errorOf('[proxy]\nupstream_anthropic = "http://example.com"\n').message).toContain(
      "proxy.upstream_anthropic: must use https",
    );
  });

  it("refuses a team token_env that is not an environment variable name", () => {
    expect(errorOf('[team]\ntoken_env = "my token"\n').message).toContain("team.token_env:");
  });

  it("reads price overrides by model", () => {
    const config = parseConfig(
      '[prices."my-model"]\ninput = 1\noutput = 2\ncache_write_5m = 1.25\ncache_write_1h = 2\ncache_read = 0.1\n',
      "config.toml",
    );
    expect(config.prices["my-model"]?.output).toBe(2);
    expect(errorOf('[prices."m"]\ninput = 1\n').message).toContain("prices.m.output:");
  });
});

describe("parsePrices", () => {
  it("reads a models table and refuses a negative price", () => {
    const text = '[models."m"]\ninput = 1\noutput = 2\ncache_write_5m = 1.25\ncache_write_1h = 2\ncache_read = 0.1\n';
    expect(parsePrices(text, "prices.toml").m?.input).toBe(1);
    expect(() => parsePrices(text.replace("input = 1", "input = -1"), "prices.toml")).toThrow("models.m.input:");
  });
});
