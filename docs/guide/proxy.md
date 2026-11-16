# Proxy, budgets and loop guards

The daemon listens on `127.0.0.1:7788` (`[proxy] port`). It only answers requests addressed to this machine.

## Sessions

`grenier run -- <command>` registers a session (its directory, its git repository, when it started), points the
command at `http://127.0.0.1:7788/s/<session>`, and closes the session when the command exits. The command's exit code
is Grenier's. Requests without the `/s/<session>` prefix are counted under `untagged`.

Anthropic's Messages API is served at the root; OpenAI's API (Chat Completions, Responses) under `/openai/`, sent to
`[proxy] upstream_openai`, which can be any OpenAI-compatible server. Codex has to use an API key
(`codex login --with-api-key`): a ChatGPT sign-in only works with ChatGPT's own backend, so the proxy refuses it with a
message rather than send it to OpenAI's API.

## What is recorded

One row per model call: the session, the model, input tokens, prompt-cache writes and reads, output tokens, the cost
and the HTTP status. Prices come from `packages/log/prices.toml`; set your own under `[prices."<model>"]`. A model with
no price is reported as unpriced, never as free. API keys and `Authorization` headers are forwarded and never stored.

## Budgets

| Limit | Set with | Counts |
| --- | --- | --- |
| Daily | `grenier budget set --daily 10` | everything spent today (local time) |
| Session | `--session 3` | one `grenier run` |
| Repository | `--repo app=2` | today's spending in sessions of that repository |
| Team, member | `grenier team budget --team 50 --member 10` | the team's UTC day ([Teams](./team.md)) |

`[budgets] daily` and `session` in config.toml set defaults; `grenier budget set` wins over them. A reached limit gets
an HTTP 429 with `x-should-retry: false` and a message such as:

> Grenier stopped this request: the daily budget of $10.00 is reached ($10.04 spent). To change it, run: grenier
> budget set --daily \<amount>

Claude Code and the Anthropic SDKs show it and stop, without retrying.

## Loop guards

Grenier hashes every tool call an agent makes (the tool and its input, key order ignored) and every tool error. When
the same one comes 3 times in the last 10 calls (`[guards] loop_repeat_threshold`, `loop_window`), it raises a loop
event:

- `on_loop = "notify"` (the default): a desktop notification, and the event in the log.
- `on_loop = "pause"`: the session's next request waits until `grenier resume <session>`, or gets an error after
  `pause_timeout` seconds (600).

## The prompt cache

Grenier never changes a request unless you ask it to. `grenier report --cache` shows, per session, how much input was
written to the prompt cache and how much read from it, and flags sessions where three requests in a row were mostly
cache writes: something early in their prompt keeps changing. `[proxy] inject_cache_control = true` adds automatic
caching to requests that set none, and logs each change.
