import { ConfigError, defaultConfig, parseConfig, parsePrices } from "@grenier/core";
import { describe, expect, it } from "vitest";

const PLAN_EXAMPLE = `
[proxy]
port = 7788
upstream_anthropic = "https://api.anthropic.com"

[budgets]
daily = 10
session = 3

[guards]
loop_repeat_threshold = 3
loop_window = 10
on_loop = "notify"

[cache]
embeddings = "local"
share_with_team = false

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
  it("fills every section with its defaults and sets no budget", () => {
    expect(defaultConfig()).toEqual({
      proxy: {
        port: 7788,
        upstream_anthropic: "https://api.anthropic.com",
        upstream_openai: "https://api.openai.com",
        inject_cache_control: false,
      },
      budgets: {},
      guards: { loop_repeat_threshold: 3, loop_window: 10, on_loop: "notify", pause_timeout: 600 },
      cache: { embeddings: "local", share_with_team: false },
      team: { url: "", token_env: "GRENIER_TEAM_TOKEN", sync_interval: 20 },
      sources: { sync_interval: 300 },
      prices: {},
    });
  });
});

describe("parseConfig", () => {
  it("reads the example config from the plan", () => {
    const config = parseConfig(PLAN_EXAMPLE, "config.toml");
    expect(config.budgets).toEqual({ daily: 10, session: 3 });
    expect(config.guards.on_loop).toBe("notify");
  });

  it("treats an empty file as all defaults", () => {
    expect(parseConfig("", "config.toml")).toEqual(defaultConfig());
  });

  it("fills the keys a section leaves out", () => {
    const config = parseConfig("[proxy]\nport = 9000\n", "config.toml");
    expect(config.proxy).toEqual({
      port: 9000,
      upstream_anthropic: "https://api.anthropic.com",
      upstream_openai: "https://api.openai.com",
      inject_cache_control: false,
    });
    expect(config.guards.loop_window).toBe(10);
  });

  it("allows plain http to a loopback upstream", () => {
    const config = parseConfig('[proxy]\nupstream_anthropic = "http://127.0.0.1:9999"\n', "config.toml");
    expect(config.proxy.upstream_anthropic).toBe("http://127.0.0.1:9999");
  });

  it("names the file, line and column of a TOML syntax error", () => {
    const error = errorOf("[proxy]\nport = = 1\n");
    expect(error.message).toMatch(/^config\.toml:2:\d+: /);
    expect(error.message).not.toContain("\n");
  });

  it("names an unknown key, so a typo does not pass silently", () => {
    expect(errorOf("[proxi]\nport = 1\n").message).toBe('Invalid config in config.toml:\n  Unrecognized key: "proxi"');
    expect(errorOf("[proxy]\nprot = 1\n").message).toContain('proxy: Unrecognized key: "prot"');
  });

  it("names the key of a value of the wrong type or range", () => {
    expect(errorOf('[proxy]\nport = "7788"\n').message).toContain("proxy.port:");
    expect(errorOf("[proxy]\nport = 70000\n").message).toContain("proxy.port:");
    expect(errorOf("[budgets]\ndaily = -1\n").message).toContain("budgets.daily:");
    expect(errorOf('[guards]\non_loop = "kill"\n').message).toContain("guards.on_loop:");
  });

  it("lists every problem, not just the first", () => {
    const lines = errorOf('[proxy]\nport = 0\n[guards]\non_loop = "kill"\n').message.split("\n");
    expect(lines).toHaveLength(3);
  });

  it("refuses an upstream that would receive API keys over plain http", () => {
    expect(errorOf('[proxy]\nupstream_anthropic = "http://example.com"\n').message).toContain(
      "proxy.upstream_anthropic: must use https",
    );
  });

  it("refuses a loop threshold larger than the window", () => {
    expect(errorOf("[guards]\nloop_repeat_threshold = 11\nloop_window = 10\n").message).toContain(
      "guards.loop_repeat_threshold: loop_repeat_threshold must not exceed loop_window",
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
