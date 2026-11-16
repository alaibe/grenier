# Grenier

Grenier sits between your AI tools and everything they read. It records what coding agents spend and stops runaway
sessions, keeps what they learn about a codebase so the next session doesn't pay to learn it again, shares that across
a team, and gives AI tools scoped, logged access to your notes, mail and calendar.

It is one local daemon, free and open source (MIT). The team server runs in your own Cloudflare account; there is no
hosted service.

## What it does

- **Every model call recorded.** Run an agent with `grenier run -- claude`: each request passes through unchanged and
  streamed, and Grenier keeps its tokens, prompt-cache reads and writes, and cost, by session and repository.
- **Budgets and loop guards.** Daily, per-session, per-repository and team limits, checked before a request leaves.
  The agent gets an error that says which limit and how to raise it, and does not retry. Repeated tool calls raise a
  notification, or pause the session until you resume it.
- **An exploration cache for codebases.** Agents ask `ask_codebase` before reading code and `record_answer` after.
  An answer is reused, by any agent and any teammate, until one of the files it came from changes; then it comes back
  stale, with the files to re-read.
- **A team server you deploy.** `grenier team deploy` puts a Worker, D1 and R2 in your Cloudflare account: a shared
  cache, team budgets, and a dashboard with usage, savings and members.
- **Personal data, scoped and audited.** Notes, mail and calendars over MCP, for the tools you allow and only the
  sources you allow. Every read is logged before it returns; IBANs, phone numbers and addresses are removed; content is
  marked as untrusted. Memories an AI proposes wait for your approval.
- **A desktop app** for all of it: dashboard, sources, clients and scopes, audit log, review queue.

## Quick start

Grenier needs Node 22 or later. Until it is published, build it from source:

```bash
git clone https://git.laibe.cc/anthony/grenier.git && cd grenier
pnpm install && pnpm build
alias grenier="node $PWD/apps/cli/dist/grenier.js"

grenier run -- claude                    # an agent through the proxy
grenier report                           # what it spent
grenier budget set --daily 10            # a limit
grenier mcp install claude-code          # the exploration cache, over MCP
```

The [guide](docs/guide/getting-started.md) covers the rest: [budgets and loop guards](docs/guide/proxy.md),
[the exploration cache](docs/guide/exploration-cache.md), [teams](docs/guide/team.md),
[personal data](docs/guide/personal-data.md), [the desktop app](docs/guide/desktop.md),
[configuration](docs/guide/configuration.md) and [security](docs/guide/security.md).

## Benchmark

`bench/` asks the same questions about public repositories (Hono and Flask at pinned commits) twice through the real
proxy: once with the cache empty, once with what the first run recorded. It writes the tokens and cost of both runs
to a table. This README only publishes numbers it measured, and it has not been run with a real model yet:

```bash
ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @grenier/bench bench
```

## Security

The daemon only listens on 127.0.0.1; API keys pass through and are never stored; nothing leaves your machine unless
you share a repository or put a source in the vault, which is end-to-end encrypted. The ten rules and how they are enforced are
in [docs/guide/security.md](docs/guide/security.md).

## Development

```bash
pnpm install
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

[PLAN.md](PLAN.md) is the build plan, [docs/decisions.md](docs/decisions.md) records every choice it left open, and
[AGENTS.md](AGENTS.md) is the guide for working in this repository.

## Licence

MIT
