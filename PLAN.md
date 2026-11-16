# Grenier: build plan

Last updated: 2026-11-16

Grenier is one free, open-source (MIT) app that sits between AI tools and everything they read. Phase 1 caches what coding agents learn about a repo and controls their spend. Phase 2 shares that cache across a team through a server the team deploys to its own Cloudflare account. Phase 3 gives every AI tool scoped, logged access to personal data: mail, calendar, notes.

## How to use this plan with Claude Code

- Save this doc as `PLAN.md` at the repo root and point Claude Code at it.
- Work one phase at a time, in order. Within a phase, finish a task and its tests before starting the next.
- Tick a task's checkbox only when its acceptance criteria pass in CI.
- Anything this plan does not specify: pick the simplest option and record it in `docs/decisions.md` (one line: date, decision, reason).
- Items under **Open decisions** need a human answer. Stop and ask before building anything that depends on one.
- Never weaken a rule in **Security and privacy rules** to make a test pass.

## Product

Grenier is one install: a local daemon with a CLI, plus a desktop app from phase 3. Every AI tool connects to it once, through two doors: a model-call proxy and one MCP server. What a tool can see and spend is set per tool.

**Who it's for.** Developers and teams who pay for coding-agent tokens, first. Privacy-minded power users who want one permissioned memory across AI tools, second.

**What it does, by phase.**

| Phase | Capability | User-facing result |
| --- | --- | --- |
| 1 | Proxy + usage log | Every model call recorded: tokens, cache reads and writes, cost, by session and repo |
| 1 | Guards | Budgets per day, session and repo; loop detection that notifies or pauses |
| 1 | Exploration cache | Agents ask `ask_codebase` before grepping; answers reused until their source files change |
| 2 | Team server on Cloudflare | Shared cache, team budgets and dashboard, deployed with one command |
| 3 | Personal-data connectors | Markdown folders, IMAP mail, CalDAV/ICS calendars, searchable over MCP |
| 3 | Scopes, audit, review queue | Per-tool access, a log of every read, AI-written memories approved as diffs |
| 3 | Desktop app | Dashboard, sources, clients and scopes, audit log, review queue |

**Non-goals.**

- No hosted Grenier service and no paid tier. Every server part runs in the user's own Cloudflare account.
- No model routing between providers, and no lossy prompt compression.
- No agent features: Grenier never edits code or sends messages itself.
- No mobile app before phase 3 ships.

## Architecture

Everything runs in one local daemon. The team server is optional and lives in the team's own Cloudflare account.

```
 AI tools                Grenier daemon (your machine)          Model providers
 ┌────────────────┐      ┌───────────────────────────────┐      ┌───────────────────┐
 │ Claude Code    │      │ Gateway                       │      │ Anthropic, OpenAI │
 │ Codex, Cursor  │ ───▶ │   model-call proxy + MCP      │ ───▶ └───────────────────┘
 │ Claude, ChatGPT│      │ Policy                        │
 └────────────────┘      │   scopes, budgets, loop guards│      Your sources
                         │ Index and cache               │      ┌───────────────────┐
                         │   SQLite, full-text, vectors  │ ◀─── │ Code repos   (P1) │
                         │ Log                           │      │ Personal data(P3) │
                         │   usage, audit, money saved   │      │ mail, cal, notes  │
                         └───────────────▲───────────────┘      └───────────────────┘
                                         │ opt-in sync
                                         ▼
                         ┌───────────────────────────────┐
                         │ Team server (P2), your        │
                         │ Cloudflare: Workers, D1,      │
                         │ Vectorize, R2                 │
                         │ shared cache, budgets, sync   │
                         └───────────────────────────────┘
```

AI tools reach the daemon through the gateway. The policy engine checks every call; the index answers from the cache or from your sources; the log records it. Model calls are forwarded upstream. With sync turned on, the daemon exchanges cache entries, budgets and encrypted vault data with the team server.

## Codebase

One monorepo in TypeScript, so the same core runs on a laptop and on Cloudflare Workers. Rust appears only as the Tauri shell of the desktop app.

```
grenier/
  PLAN.md                this document
  docs/decisions.md      one line per decision made during the build
  packages/
    core/                config, types, policy engine (scopes, budgets, loop guards)
    store/               storage interface + adapters: local SQLite, Cloudflare D1/Vectorize/R2
    index/               content-hash keyed cache, full-text + vector search, embeddings
    gateway/             model-call proxy (Hono) + MCP server
    log/                 usage and audit records, cost calculation, reports
    connectors/          git (phase 1); markdown, IMAP, CalDAV/ICS (phase 3)
  apps/
    cli/                 `grenier` command and local daemon
    server/              Cloudflare Worker: team cache, team budgets, dashboard, vault sync
    desktop/             Tauri v2 app; runs the daemon as a bundled sidecar (phase 3)
  bench/                 token benchmark on public repos
```

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22 LTS | Stable, and the daemon can be compiled to one binary for the Tauri sidecar |
| Package manager | pnpm workspaces | Simple monorepo, fast installs |
| HTTP | Hono | The same router runs on Node and on Workers |
| MCP | `@modelcontextprotocol/sdk` | Official TypeScript SDK; stdio and Streamable HTTP |
| Local storage | SQLite via `better-sqlite3`, FTS5, `sqlite-vec` | One file, no daemon, hybrid search |
| Server storage | D1, Vectorize, R2, Durable Objects | Cloudflare equivalents of the local stores |
| Embeddings | Small local model by default, Workers AI on the server | No cloud call needed locally |
| Tests | Vitest | Fast, TypeScript-native |
| Lint and format | Biome | One tool, no config sprawl |
| CI | GitHub Actions | Lint, typecheck, test on every push |

**Conventions.**

- `packages/*` never import from `apps/*`.
- All storage goes through the `store` interface. No package talks to SQLite or D1 directly.
- Every public function in `core`, `index` and `gateway` has a unit test.
- Config lives in `~/.grenier/config.toml`; data in `~/.grenier/grenier.db`. Both paths can be overridden by env vars.

## Interfaces

### Model-call proxy

- Listens on `127.0.0.1:7788` (configurable). Phase 1 supports the Anthropic Messages API; phase 2 adds OpenAI-compatible endpoints.
- `grenier run -- <agent command>` registers a session (id, working directory, git repo root, start time). It sets `ANTHROPIC_BASE_URL=http://127.0.0.1:7788/s/<session-id>`, launches the command and closes the session when it exits. Requests without the `/s/<id>` prefix are logged under an `untagged` session.
- Forward method, path, headers and body unchanged to the upstream (default `https://api.anthropic.com`). Stream server-sent events back as they arrive; never buffer a whole stream.
- Read usage from the response: input tokens, cache-creation tokens, cache-read tokens and output tokens, from the `message_start` and `message_delta` events. Write one usage row per request.
- Auth headers (`x-api-key`, `authorization`) are forwarded and never stored or logged.
- **Budget check before forwarding.** When a limit is reached, return an Anthropic-style error JSON whose message names the limit and the command to change it. Use a status code the agent does not retry; confirm the behaviour with Claude Code in a test.
- **Loop detection.** For each session, hash every `tool_use` (tool name + canonical JSON of its input) and every error `tool_result`. When the same hash appears 3 or more times in the last 10 tool calls (both configurable), raise a loop event. `on_loop = "notify"` sends a desktop notification and logs it. `on_loop = "pause"` holds the session's next request until `grenier resume <session>`, or answers with an error after a timeout.
- **Prompt-cache report (observe only).** Per session, record the share of input tokens that were cache writes vs cache reads, and flag sessions where cache writes stay high across consecutive requests. Phase 1 never rewrites requests. Injecting `cache_control` for clients that send none is an opt-in flag, off by default.

### MCP server

One server, available over stdio (for local agents) and Streamable HTTP on the same port (for apps). Its server instructions tell the agent: call `ask_codebase` before exploring code; after working out how something works, call `record_answer` with the files you read.

| Tool | Input | Output | Phase |
| --- | --- | --- | --- |
| `ask_codebase` | `question`, optional `repo` | `status` (`hit`, `stale`, `miss`), `answer`, `sources` (path + blob hash), `changed` (paths edited since) | 1 |
| `record_answer` | `question`, `answer`, `files` (paths read) | `id`; stores each file's current blob hash | 1 |
| `file_summary` | `path` | Cached summary if the blob hash matches, else `miss` | 1 |
| `repo_map` | optional `repo` | Compact list of top-level modules with their cached summaries | 1 |
| `search` | `query`, optional `sources`, `limit` | Matching items from sources the caller's scope allows | 3 |
| `get` | `id` | One item, if in scope | 3 |
| `timeline` | `subject`, optional `from`, `to` | Dated items about the subject, in order | 3 |
| `people` | `name` | Items and threads involving that person | 3 |
| `remember` | `text`, optional `tags` | A pending entry in the review queue; never written directly | 3 |

### CLI

| Command | Does | Phase |
| --- | --- | --- |
| `grenier start`, `stop`, `status` | Control the local daemon | 1 |
| `grenier run -- <cmd>` | Run an agent through the proxy as a tagged session | 1 |
| `grenier report [--by day\|session\|repo] [--since 7d]` | Tokens, cache hit rate, cost, money saved | 1 |
| `grenier budget set --daily <n> --session <n> [--repo <name>=<n>]` | Set limits | 1 |
| `grenier resume <session>` | Release a paused session | 1 |
| `grenier mcp install <claude-code\|cursor\|codex\|claude-desktop>` | Write the MCP config for that client | 1 |
| `grenier cache stats`, `cache clear [--repo <name>]` | Inspect or empty the cache | 1 |
| `grenier team deploy` | Deploy `apps/server` to the user's Cloudflare account through Wrangler | 2 |
| `grenier team join <url> <token>` | Connect this machine to a team server | 2 |
| `grenier sources add <markdown\|imap\|caldav> ...` | Add a personal-data source | 3 |
| `grenier clients add <name> --scope <sources>` | Create a client token with its scope | 3 |
| `grenier audit [--client <name>]` | Show every read, per client | 3 |

### Config file

```toml
# ~/.grenier/config.toml
[proxy]
port = 7788
upstream_anthropic = "https://api.anthropic.com"

[budgets]            # in the provider's billing currency
daily = 10
session = 3

[guards]
loop_repeat_threshold = 3
loop_window = 10
on_loop = "notify"   # or "pause"

[cache]
embeddings = "local"
share_with_team = false

[team]               # phase 2
url = ""
token_env = "GRENIER_TEAM_TOKEN"
```

Model prices live in `packages/log/prices.toml`, maintained in the repo and overridable in the user config. No price is hard-coded anywhere else.

## Data model

One SQLite file locally; the same schema on D1 for the team server, with vectors in Vectorize instead of `sqlite-vec`. Migrations live in `packages/store/migrations/` and run on start.

```sql
-- sessions and usage (phase 1)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, client TEXT, repo_root TEXT, repo_id TEXT,
  cwd TEXT, started_at INTEGER, ended_at INTEGER, paused INTEGER DEFAULT 0
);
CREATE TABLE usage (
  id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, model TEXT,
  input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
  output_tokens INTEGER, cost REAL, status INTEGER
);
CREATE TABLE events (            -- loop detected, budget hit, pause, resume
  id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, kind TEXT, detail TEXT
);

-- exploration cache (phase 1)
CREATE TABLE file_summaries (
  repo_id TEXT, path TEXT, blob_hash TEXT, summary TEXT, created_at INTEGER,
  PRIMARY KEY (repo_id, path, blob_hash)
);
CREATE TABLE answers (
  id TEXT PRIMARY KEY, repo_id TEXT, question TEXT, answer TEXT,
  created_at INTEGER, hits INTEGER DEFAULT 0, author TEXT
);
CREATE TABLE answer_sources (     -- an answer is valid only while every blob still matches
  answer_id TEXT, path TEXT, blob_hash TEXT
);
CREATE VIRTUAL TABLE answers_fts USING fts5(question, answer, content='answers');
-- plus a sqlite-vec table of question embeddings keyed by answer id

-- policy (phase 1 budgets, phase 3 scopes)
CREATE TABLE budgets (scope TEXT, key TEXT, limit_amount REAL, period TEXT);
CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, scopes TEXT,  -- JSON list of source ids
  created_at INTEGER, revoked_at INTEGER
);

-- personal data (phase 3)
CREATE TABLE sources (id TEXT PRIMARY KEY, kind TEXT, config TEXT, last_sync INTEGER);
CREATE TABLE items (
  id TEXT PRIMARY KEY, source_id TEXT, kind TEXT, title TEXT, body TEXT,
  people TEXT, ts INTEGER, content_hash TEXT
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY, ts INTEGER, client_id TEXT, tool TEXT,
  args TEXT, item_ids TEXT                     -- JSON list of what was returned
);
CREATE TABLE review_queue (
  id TEXT PRIMARY KEY, client_id TEXT, text TEXT, tags TEXT, ts INTEGER, state TEXT
);
```

- `repo_id` = a hash of the repo's first commit, so clones on different machines share one cache.
- Blob hashes come from git (`git ls-files -s`, or `git hash-object` for unstaged files), never from file timestamps.
- `answers.author` is `local` or a team member id, so the team dashboard can credit who saved what.

## Build phases

Each task lists what must be true before its box is ticked.

### Phase 0: scaffold

- [x] Monorepo with the layout above, pnpm workspaces, Biome, Vitest, TypeScript strict mode
  - Done when: `pnpm lint`, `pnpm typecheck` and `pnpm test` pass in GitHub Actions.
  - They pass in Forgejo Actions, the origin's CI (docs/decisions.md).
- [x] Config loader and SQLite migrations in `core` and `store`
  - Done when: a fresh machine gets `~/.grenier/` created on first run; invalid config fails with a clear message.
- [x] `grenier --version` and `grenier status` run from a built binary

### Phase 1: local cache and guards

- [x] Proxy passthrough with streaming
  - Done when: Claude Code works unchanged through `grenier run -- claude`; a recorded streaming response is replayed byte for byte in a test.
- [x] Usage log and `grenier report`
  - Done when: every request writes a usage row with the four token counts; the report groups by day, session and repo; costs come from `prices.toml` only.
- [x] Budgets
  - Done when: a session over its limit gets the error before any upstream call; the agent does not retry it; `grenier budget set` takes effect without a restart.
- [x] Loop detection with notify and pause
  - Done when: a fixture with the same tool call 3 times raises one loop event; pause holds the next request until `grenier resume`.
- [x] Exploration cache: `record_answer`, `ask_codebase`, `file_summary`, `repo_map`
  - Done when: an answer is a `hit` until one of its source files changes, then `stale` with the changed paths listed; hybrid search finds a reworded question.
- [x] `grenier mcp install` for Claude Code, Cursor, Codex and Claude Desktop
  - Done when: each writes a valid config, and an end-to-end test calls `ask_codebase` over stdio.
- [x] Prompt-cache report (observe only)
  - Done when: the report shows cache-write vs cache-read share per session and flags high-churn sessions.
- [x] Benchmark in `bench/`
  - Done when: one command runs the same questions on public repos twice, cold then warm, and writes tokens and cost for both runs to a Markdown table.
  - Run on 2026-11-16 with Claude Code on Claude Opus 5.5, capped at $3.75: $2.97 cold, $0.40 warm
    (`bench/results/2026-11-16.md`).

### Phase 2: team server on Cloudflare

- [x] `apps/server` Worker: Hono routes, D1 schema, Vectorize index, Durable Object per team for budget counters
  - Built without Vectorize: search stays on each machine (docs/decisions.md).
- [ ] `grenier team deploy` and `grenier team join`
  - Done when: a new Cloudflare account goes from nothing to a working team server with one command plus `wrangler login`.
  - Built and tested against a stand-in for Wrangler and against the Worker in Miniflare; waiting for a run on a real
    Cloudflare account.
- [x] Shared cache: answers and summaries sync up and down; local stays the source of truth while offline
  - Done when: an answer recorded on machine A is a `hit` on machine B within one minute.
- [x] Team budgets and per-member usage
- [x] Dashboard page served by the Worker: usage, hit rate, savings, members, revoke
  - Done when: a revoked token gets 401 on its next call.
- [x] OpenAI-compatible proxy endpoints, for Codex and others
  - Codex is pointed at them with `-c openai_base_url`, with an API key; tested with recorded fixtures and a stand-in
    `codex`, not yet with Codex itself.

### Phase 3: personal data and desktop app

- [x] Connectors: markdown folder (watched), IMAP, CalDAV/ICS, with incremental sync
  - IMAP and CalDAV are tested through stand-ins for their client libraries, not yet against a real server.
- [x] Phase 3 MCP tools: `search`, `get`, `timeline`, `people`, `remember`
- [x] Client tokens and scopes
  - Done when: a client without the mail scope cannot get any mail item through any tool (tested against every tool).
- [x] Audit log of every read, and revoke
- [x] Review queue: `remember` writes land as pending, approved or rejected by the user
- [x] Redaction rules (IBAN, phone numbers, postal addresses) applied before results leave the daemon
- [x] Encrypted sync between devices through R2
  - Done when: the R2 objects are unreadable without the user's key, checked in a test.
- [x] Tauri desktop app: dashboard, sources, clients and scopes, audit log, review queue
  - CI builds its web UI; the app bundle is built and was checked by hand on a Mac (docs/decisions.md).

### Phase 4: launch

- [x] README with install, a quick start and the benchmark table
- [ ] Docs site generated from `docs/`
  - Built on laibe's `grenier-site` branch (not pushed), on the model of Statim's site: `grenier.laibe.cc`, its guide a
    verbatim copy of `docs/guide`, laibe's checks green. Goes live once the host has a Cloudflare Tunnel hostname and the branch is merged.
- [x] Demo video script: the same task run cold, then cached, with the token counter on screen
  - `docs/launch/demo-script.md`.
- [ ] Show HN post, then Product Hunt launch with real benchmark numbers
  - Drafts in `docs/launch/posts.md`, with the measured numbers; posted by the owner once the GitHub repository and
    the site are public.

## Testing and benchmarks

- **Unit tests** for every public function in `core`, `index`, `gateway` and `log`.
- **Recorded fixtures** for the proxy: real request and response pairs, streaming included, with keys and personal content scrubbed. Tests never call a live model API.
- **End-to-end tests** run the daemon, connect an MCP client over stdio and HTTP, and exercise each tool.
- **Worker tests** for `apps/server` run locally against Wrangler's local D1 and R2.
- **Scope tests** (phase 3) call every tool with every client scope and assert nothing out of scope comes back.
- **Benchmark.** `bench/` picks a few public repos and a fixed set of questions. It runs each question cold, then again with the cache warm, through the real proxy, and writes a Markdown table of tokens and cost per run. It is run by hand with the user's own API key, never in CI. The README publishes only numbers this benchmark measured.

## Security and privacy rules

These are hard rules. A failing test is never a reason to relax one.

1. The daemon binds to `127.0.0.1` only. Its HTTP endpoints need a client token, except the proxy path used by `grenier run`.
2. API keys and auth headers are forwarded, never stored, logged or sent to the team server.
3. Nothing leaves the machine by default. Team sharing and sync are opt-in, per repo and per source.
4. The team server stores answers and summaries. It never stores raw file contents. Summaries must not quote more than a short snippet of code.
5. Vault sync is end-to-end encrypted; the key never leaves the user's devices. The server only ever sees ciphertext.
6. Content from personal sources is returned to the AI marked as untrusted data, inside clear delimiters, so instructions hidden in an email are not treated as instructions.
7. Every phase 3 read writes an audit row before the result is returned. If the audit write fails, the read fails.
8. Client tokens are stored hashed. Revocation takes effect on the next call.
9. The proxy changes request bodies only when the user has turned an option on, and every change is logged.
10. Dependencies are pinned, and CI runs a dependency audit.

## Open decisions

Claude Code stops and asks before building anything that depends on one of these. Ticked ones were decided on
2026-11-16; `docs/decisions.md` says how and why.

- [x] **Name.** Check that "grenier" is free on GitHub, npm and a `.dev` domain before the first public commit.
  - Kept: free on npm (`grenier`); on GitHub as `alaibe/grenier` (the bare `grenier` account is someone else's);
    the site at `grenier.laibe.cc`, as the other apps, rather than `grenier.dev`, registered by someone else since 2019.
- [x] **Provider terms.** Confirm that a local proxy which reads usage and enforces budgets is allowed with API keys and with subscription sign-in, for each provider supported.
  - Anthropic: API keys and subscription sign-in. OpenAI: API keys; Codex with a ChatGPT sign-in is not supported
    through Grenier (docs/decisions.md).
- [x] **Indexing cost.** Should Grenier pre-build file summaries with a small model (costs tokens up front) or only cache what agents record (free, slower to warm up)? Default proposal: record-only in phase 1, pre-build as an opt-in command.
- [x] **Budget error code.** Which status code stops each agent cleanly without a retry loop? Decided by test in phase 1.
- [x] **Embedding model.** Which small local model is the default, given size and licence?
- [x] **Desktop UI framework** for Tauri (React or Svelte). Only needed in phase 3.

## Market context

Existing tools either shrink each request or store memories one agent saves. None caches understanding of a codebase across agents and teammates, and few control which AI sees which personal data. Grenier does both from one core.

| Product | What it does | What Grenier adds |
| --- | --- | --- |
| [LiteLLM](https://docs.litellm.ai/docs/tutorials/claude_code_cut_costs) | Gateway with budgets, prompt-cache injection, compression, auto-routing | Codebase knowledge reused across sessions and teammates |
| [Pruner](https://github.com/OneGoToAI/Pruner) | Local proxy that prunes context and truncates tool output | Nothing thrown away; answers reused instead |
| [ProtoMap](https://aitoolly.com/ai-news/article/2026-11-10-protomap-launches-to-streamline-grpc-architecture-and-slash-token-costs-for-ai-coding-agents) | Precomputed gRPC dependency graph over MCP | Any question about any codebase, not only gRPC |
| [beacon.sh](https://aitoolly.com/producthunt-daily/2026-11-02) | Shared memory and visibility for coding-agent sessions | Budgets, loop guards and cache economics |
| ccusage, cc-ledger | Usage tracking from logs or hooks | Control at request time, not reports after the fact |
| [Kuku](https://hunted.space/product/kuku) | Local Markdown second brain with AI edits as diffs | Mail and calendar sources, per-tool scopes, audit |
| [uctx](https://glama.ai/mcp/servers/kl9ytkx6n4) | Small local MCP memory server | Scopes and revocation, which uctx lists as roadmap |

## Sources

- [LiteLLM: Claude Code – Cut Costs](https://docs.litellm.ai/docs/tutorials/claude_code_cut_costs)
- [Pruner on GitHub](https://github.com/OneGoToAI/Pruner)
- [ProtoMap launch coverage (aitoolly)](https://aitoolly.com/ai-news/article/2026-11-10-protomap-launches-to-streamline-grpc-architecture-and-slash-token-costs-for-ai-coding-agents)
- [Product Hunt daily, Nov 2 2026 (beacon.sh)](https://aitoolly.com/producthunt-daily/2026-11-02)
- [Kuku: open source on hunted.space](https://hunted.space/product/kuku)
- [uctx on Glama](https://glama.ai/mcp/servers/kl9ytkx6n4)
