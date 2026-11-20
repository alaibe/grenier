# Working in this repository

## Security and privacy rules

Hard rules: a failing test is never a reason to relax one.

- The daemon binds to `127.0.0.1` only. Its HTTP endpoints need a client token, except the proxy path `grenier run`
  uses. Client tokens are stored hashed, and a revoked one fails on its next call.
- API keys and auth headers (`x-api-key`, `authorization`) are forwarded, never stored, logged or sent to the team
  server.
- Nothing of the user's leaves the machine by default: team sharing and sync are opt-in, per repository and per
  source. The one exception, on by default, is the desktop app's usage statistics below.
- The desktop app's usage statistics (`apps/desktop/src-tauri/src/usage.rs`) are page views to Umami at
  stats.laibe.cc, from release builds only, until turned off in its Settings. The page passes only a screen's url, from
  the fixed list, and the display's size; Rust refuses any other url or field and builds the hit itself, so no
  repository, session, source, path, id, amount or text the app shows ever goes in it.
  - When: a screen once it has stayed a second in front, never twice in a row, and again after 30 minutes or more
    away. Nothing while the app is behind other apps or hidden, launch included (`src/usage/tracker.ts`, fed by
    `src/usage/front.ts`). A wake from sleep with the app in front sends no return hit until the next screen change or
    app switch: a known limit, the same in Kestrel and Statim.
  - The store, `usage.json` in the app's local data folder, holds either `{"id":…,"made":…}` or `{"off":true}`.
    Nothing stored is on; anything else is damaged and counts as off. The id is random, made for this alone at the
    first hit, and replaced at the next hit once it is 365 days old or dated in the future (CNIL's 13-month limit for
    audience-measurement trackers). Off replaces it at once; on removes an off or damaged store, and the next hit makes
    a new id. No hit leaves when a new id can't be saved.
  - Shared with Kestrel and Statim, byte for byte: `src/usage/tracker.ts`, `src/usage/use-usage.ts` and
    `src-tauri/src/usage-vectors.json`. `usage.rs`'s core is the same text as Kestrel's. Change all three apps
    together.
  - The CLI, the daemon and the team server send none.
- The team server never stores file contents, prompts or keys, and a summary quotes at most a short snippet of code:
  answers and summaries pass `unshareable` (`@grenier/core/policy`) on both sides, and usage goes up as numbers.
- The vault key never leaves the user's devices: `seal`/`open` (`@grenier/core/vault`) run locally; the server stores
  bytes it cannot read.
- Personal data leaves the daemon only through `packages/index/src/personal.ts`: the client's scope filters it, the
  audit row is written first (no row, no read), and every item is redacted (`redact` in `@grenier/core/policy`) and
  wrapped in an untrusted-data block. A new read path goes through `deliver` there, and its test belongs in
  `tests/unit/personal/scopes.test.ts`, against every scope.
- The proxy changes a request body only when an opt-in flag is on, and logs every change.
- Dependencies are exact versions and CI audits them; pnpm refuses releases younger than 7 days
  (`pnpm-workspace.yaml`), and install scripts run only for the packages listed there.

## Before you finish

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

Biome formats and lints (`biome.json`), and `pnpm format` runs rustfmt too; `tsc` only typechecks; `pnpm test:e2e`
builds the CLI and runs the built file. When `apps/desktop/src-tauri` changes, also run
`cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` there, after the desktop UI and sidecar
are built (below).
`pnpm test:agents` runs Claude Code itself through the daemon against a stand-in API, plain and with the benchmark's
own command; run it by hand when the proxy, the MCP tools or `bench/` change (CI has no Claude Code).

## Comments

Keep comments to the minimum. Add one only when it explains something the code cannot make clear; never restate the
code.

## Layout

- `packages/*` are libraries, `apps/*` are what runs: `apps/cli` is the `grenier` command and the daemon.
  `core` holds config and policy (budgets, loop detection), `store` the schema and SQLite, `log` prices, cost and
  reports, `index` the exploration cache, embeddings and team sync, `gateway` the proxy (Anthropic, and OpenAI under
  `/openai/`) and the MCP server (Hono), `connectors` the sources (git, markdown, IMAP, CalDAV/ICS). `apps/server` is
  the team server, a Cloudflare Worker (D1, a Durable Object per team), typechecked on its own
  (`apps/server/tsconfig.json`) and bundled into the CLI's
  `dist/server` for `grenier team deploy`. `apps/desktop` is the Tauri app (React UI in `src`, Rust shell in
  `src-tauri`), talking to the daemon's admin API (`packages/gateway/src/admin.ts`). The UI is styled with Tailwind
  utilities; its theme (colours, light and dark, type scale, breakpoints) and the few element defaults are
  `src/styles.css`, and the shared pieces (`Button`, `Field`, `Table`…) are in `src/ui.tsx`. Its screens are listed in
  `src/usage/screens.ts` and again in `src-tauri/src/usage.rs`, which `tests/unit/desktop/usage-screens.test.ts` keeps
  equal. The Rust shell is formatted at 120 columns (`src-tauri/rustfmt.toml`), and `tauri-build` needs the web UI
  and the sidecar in place before it compiles: `pnpm build`, `pnpm --filter @grenier/desktop build` and
  `pnpm --filter @grenier/desktop sidecar`.
- The desktop app bundle: `pnpm build`, `pnpm --filter @grenier/desktop sidecar [--target <triple>]` (downloads Node's
  official build, checked against the SHA-256 pinned in `scripts/prepare-sidecar.mjs`), then
  `pnpm --filter @grenier/desktop tauri build`. CI builds its web UI and sidecar and tests the shell; releases build
  it for macOS, Linux and Windows (`docs/RELEASE.md`).
- Tests are in `tests/`: `unit/<package>` per workspace, `e2e` against the built CLI, `agents` with real agents,
  `fixtures` for recorded data, `support` for shared helpers.
  Unit tests import a package through its public entry (`@grenier/core`, `@grenier/store/sqlite`).
- CI is `.forgejo/workflows/ci.yml`, on git.laibe.cc: one `check` job on every push, as in Kestrel and Statim. It
  installs Tauri's Linux packages, Rust and the shell tools, builds the desktop UI and sidecar, then runs Format
  (Biome, rustfmt, shfmt), Lint (Biome, Clippy, shellcheck, the audit, the version files), Types, Tests (Vitest, then
  `cargo test`) and E2e. `nightly.yml` runs Types and Tests on the Mac before it tags a release when main has changed,
  and `release.yml` builds and publishes it on `github.com/alaibe/grenier` (`docs/RELEASE.md`).
- `priv/` is gitignored except its `.gitkeep`: the maintainer's own material (launch posts, the demo script, Product
  Hunt's images) lives there, and new material of that kind goes there too. Its README lists what is in it. A worktree
  has no `priv/`; use the main checkout's.

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
- The team server's own migrations are in `apps/server/migrations`, applied by Wrangler.
- No test touches the real `~/.grenier`: set `GRENIER_HOME` to a temporary directory. As a backstop, the unit tests
  run with `HOME` pointed at a throwaway folder (`tests/support/home.ts`).
- Prices live only in `packages/log/prices.toml` (overridable under `[prices]` in config.toml). Never write a price
  anywhere else.
- Every package is private until the release workflow publishes it; the name is settled (Grenier).
- The version is in six files kept equal by `scripts/version.ts`; change them together (`check` says when they differ).
- The site, `grenier.laibe.cc`, and its user guide live in the laibe repository (`../laibe/content/grenier/guide`).
  When a change alters how Grenier is used, update the guide there; a new or renamed config key gets its line in
  `configuration.md`. Outside code, write `\<word>`: the site drops a bare `<word>`.
