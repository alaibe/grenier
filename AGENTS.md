# Working in this repository

`PLAN.md` is the build plan: work one phase at a time, one task and its tests at a time, and tick a task's box only
once its acceptance criteria pass in CI. Anything the plan leaves open: pick the simplest option and add a line to
`docs/decisions.md`. Stop and ask before building anything that depends on an item under **Open decisions**. Never
weaken a rule under **Security and privacy rules** to make a test pass.

## Before you finish

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

Biome formats and lints (`biome.json`); `tsc` only typechecks; `pnpm test:e2e` builds the CLI and runs the built file.
`pnpm test:agents` runs Claude Code itself through the daemon against a stand-in API; run it by hand when the proxy
changes (CI has no Claude Code).

## Comments

Keep comments to the minimum. Add one only when it explains something the code cannot make clear; never restate the
code.

## Layout

- `packages/*` are libraries, `apps/*` are what runs: `apps/cli` is the `grenier` command and the daemon.
  `core` holds config and policy (budgets, loop detection), `store` the schema and SQLite, `log` prices, cost and
  reports, `index` the exploration cache, embeddings and team sync, `gateway` the proxy (Anthropic, and OpenAI under
  `/openai/`) and the MCP server (Hono), `connectors` git. `apps/server` is the team server, a Cloudflare Worker (D1,
  a Durable Object per team), typechecked on its own (`apps/server/tsconfig.json`) and bundled into the CLI's
  `dist/server` for `grenier team deploy`.
- Tests are in `tests/`: `unit/<package>` per workspace, `e2e` against the built CLI, `agents` with real agents,
  `fixtures` for recorded data, `support` for shared helpers.
  Unit tests import a package through its public entry (`@grenier/core`, `@grenier/store/sqlite`).
- CI is `.forgejo/workflows/ci.yml`, on git.laibe.cc.

## Things that are not obvious from the code

- Workspace packages are TypeScript source: their `exports` point at `src/*.ts`, and nothing builds them on their own.
  The CLI is bundled by `apps/cli/build.mjs`; better-sqlite3 stays outside the bundle, so it is also a dependency of
  `apps/cli`.
- `@grenier/core` and `@grenier/store` must run on Cloudflare Workers too. Node-only code goes in a subpath
  (`@grenier/core/node`, `@grenier/store/sqlite`); Biome refuses a Node import anywhere else in those two packages.
- Only `packages/store` uses Drizzle, only `packages/store/src/sqlite.ts` imports better-sqlite3, and `packages/*`
  never import `apps/*`. Biome enforces all three.
- The schema is `packages/store/src/schema.ts` (Drizzle). To change it: edit that file, run `pnpm db:generate`, list
  the new SQL file in `packages/store/src/migrations.ts`, and commit the SQL and `migrations/meta/`. What Drizzle
  cannot express (the full-text index, its triggers, later sqlite-vec) goes in a migration from
  `pnpm db:generate --custom --name <what>`. A shipped migration never changes. A test fails when the migrated
  database and `schema.ts` disagree.
- Our runner applies the migrations and records them in `schema_migrations`, not Drizzle's migrator: SQL files are
  imported as text (esbuild's text loader, a Vitest plugin, `types/text.d.ts`), so they work inside the bundled CLI.
- The embedding model is downloaded on first use and checked against the SHA-256 pinned in
  `packages/index/src/node.ts`; a new model or revision is a new pin, and its vectors never mix with the old ones'
  (they are stored with the model's name). `tests/e2e/embeddings.test.ts` keeps its copy in `node_modules/.cache`.
- The team server never stores file contents, prompts or keys: answers and summaries pass `unshareable`
  (`@grenier/core/policy`) on both sides, and usage goes up as numbers. Its own migrations are in
  `apps/server/migrations`, applied by Wrangler.
- No test touches the real `~/.grenier`: set `GRENIER_HOME` to a temporary directory.
- Prices live only in `packages/log/prices.toml` (overridable under `[prices]` in config.toml). Never write a price
  anywhere else.
- The proxy never changes a request body unless an opt-in flag is on, and logs every change. It never stores or logs
  `x-api-key` or `authorization`.
- Dependencies are exact versions, and pnpm refuses releases younger than 7 days (`pnpm-workspace.yaml`). Install
  scripts run only for the packages listed there.
- Every package is private until the name is settled (Open decisions, **Name**).
