# Getting started

Grenier runs on your machine as one daemon. Every AI tool reaches it through two doors: a proxy for model calls, and
an MCP server for what it knows. This page gets a coding agent going through both.

## Install

Grenier needs Node 22 or later. Until it is published, install it from source:

```bash
git clone https://git.laibe.cc/anthony/grenier.git
cd grenier
pnpm install
pnpm build
alias grenier="node $PWD/apps/cli/dist/grenier.js"
```

`grenier status` creates `~/.grenier/` on its first run: the database, and later your config and tokens. Set
`GRENIER_HOME` to put it somewhere else.

## Run an agent through the proxy

```bash
grenier start
grenier run -- claude
```

`grenier run` starts the daemon if it is not running, gives the agent its own session, and points it at the proxy
with `ANTHROPIC_BASE_URL` (and `OPENAI_BASE_URL` for OpenAI-compatible tools; Codex gets `-c openai_base_url=…`, the
only place it reads one). The agent works exactly as
before: requests and answers pass through unchanged, streamed as they arrive. Grenier records what each one used.

```bash
grenier report                 # tokens, prompt-cache hits, cost and savings, by day
grenier report --by session    # or by repository: --by repo
grenier report --cache         # how much of each session's input came from the prompt cache
```

## Set a budget

```bash
grenier budget set --daily 10 --session 3 --repo app=2
```

Limits are in dollars, checked before each request leaves your machine. When one is reached, the agent gets an error
that names the limit and the command to raise it, and it does not retry. `--daily off` removes a limit. Changes apply
at the next request; nothing restarts.

## Give the agent the exploration cache

```bash
grenier mcp install claude-code    # or cursor, codex, claude-desktop
```

This adds Grenier's MCP server to the agent's config. The server tells the agent to ask `ask_codebase` before it
explores code, and to `record_answer` after it works something out, with the files it read. Next time anyone asks the
same thing, or something close, the answer comes back at once, for as long as those files are unchanged. When one of
them changes, the answer comes back marked stale, with the files to re-read.

```bash
grenier cache stats    # answers kept and reused, by repository
```

## Next

- [Proxy, budgets and loop guards](./proxy.md)
- [The exploration cache](./exploration-cache.md)
- [Teams](./team.md)
- [Personal data: notes, mail and calendar](./personal-data.md)
- [The desktop app](./desktop.md)
- [Configuration](./configuration.md) and [security](./security.md)
