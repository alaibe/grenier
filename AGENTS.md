# Working in this repository

## Security and privacy rules

Hard rules: a failing test is never a reason to relax one.

- The daemon binds to `127.0.0.1` only. Its HTTP endpoints need a client token, except the proxy path `grenier run`
  uses. Client tokens are stored hashed, and a revoked one fails on its next call.
- API keys and auth headers (`x-api-key`, `authorization`) are forwarded, never stored, logged or sent to the team
  store.
- Nothing of the user's leaves the machine by default: the team store is opt-in (`grenier team deploy`, or joining from
  an invite). The one exception, on by default, is the desktop app's usage statistics below.
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
  - The CLI, the daemon and the team store send none.
- The team store, in the team's own Cloudflare account, reads the records of shared spaces; it never holds file
  contents, prompts or keys. Every record passes `recordProblem` (`@grenier/core/records`) on both sides: no secret,
  and a memory quotes at most a short snippet of code. Usage goes up as numbers by day and repository folder name.
- A `me` record is sealed with the person's key before it leaves (`seal`/`open` in `@grenier/core/vault`, key in
  `personal.key`); the store keeps bytes it cannot read. Effectiveness (`outcomes`, steps, line hashes) never leaves.
- Before an agent's record leaves the machine, the person is asked through MCP elicitation (`remember` in
  `packages/index/src/records.ts`); answers and summaries anchored only to git are checked by their files instead, and
  a client that cannot ask keeps the record in `me`. Only a routine's run writes without asking.
- Records reach an MCP client only through `deliver` (`packages/index/src/records.ts`): the client's scopes pick the
  spaces (repository spaces always), the audit row is written first (no row, no read), and every item is redacted
  (`redact` in `@grenier/core/policy`) and wrapped in an untrusted-data block. A new read path goes through `deliver`,
  and its test belongs in `tests/unit/personal/scopes.test.ts`, against every scope.
- A shared skill or MCP server is installed only once this machine's person approved its hash, or it is recommended
  and they turned on `skills auto`; a skill's files land only inside `~/.claude/skills/grenier-<name>`, a server under
  `grenier-<name>` in Claude Code's config. A shared server carries the names of its credentials, never their values
  (`shareableServer` in `apps/cli/src/installs.ts`). The Skills screen's search sends only the words typed to
  skills.sh, and its share fetches that skill from GitHub at one commit (`apps/cli/src/catalog.ts`); what it fetches
  is shared like any skill, and waits for each person's approval.
- A routine runs on a machine only once its person approved its hash (`routineHash`), in a clean checkout, at the
  lowest priority. With Claude Code, read-only is enforced twice: `--tools` offers only the built-in tools the mode
  allows, and the proxy's `RunGuard` cuts the answer off before any other tool call, an MCP tool included, and stops
  the agent (`packages/gateway/src/proxy.ts`). Codex runs in its own read-only sandbox, which the proxy cannot check.
  Only an admin marks a skill or MCP server recommended, or changes what a recommended one installs (`#apply` in
  `apps/server/src/team.ts`). A GitHub job runs only in a private repository, on the runner pinned by SHA-256 in
  `apps/cli/src/github.ts`, and its hook refuses a workflow that is not the approved one.
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
  `core` holds config, policy (loop detection, redaction, what may be shared), record types and their rules, and
  routines' modes, versions and schedules; `store` the schema and SQLite; `log` prices, cost and reports; `index` the
  records (`recall`, `remember`, `query`, `deliver`), embeddings and sync with the team store; `gateway` the proxy
  (Anthropic, and OpenAI under `/openai/`), the MCP server and the admin API (Hono); `connectors` reads git
  repositories. In `apps/cli`, the daemon's link to the team store is `link.ts`, routine runs `runner.ts`, the
  machine's rules `machine.ts`, GitHub runners `github.ts`, shared skills and servers `installs.ts`, and the admin
  API's daemon-side pages `host.ts` and `routines.ts`. `apps/server` is the team store, a Cloudflare Worker with one
  Durable Object per team (its SQLite schema is `TeamStore`'s migrate, its alarm files scheduled requests), plus the
  web view and the remote MCP server; it is typechecked on its own (`apps/server/tsconfig.json`) and bundled into the
  CLI's `dist/server` for `grenier team deploy`. `apps/desktop` is the Tauri app (React UI in `src`, Rust shell in
  `src-tauri`), talking to the daemon's admin API (`packages/gateway/src/admin.ts`). The UI is styled with Tailwind
  utilities; its theme (colours, light and dark, type scale, breakpoints) and the few element defaults are
  `src/styles.css`, and the shared pieces (`Button`, `Field`, `Table`…) are in `src/ui.tsx`. Its screens are listed in
  `src/usage/screens.ts` and again in `src-tauri/src/usage.rs`, which `tests/unit/desktop/usage-screens.test.ts` keeps
  equal. The Rust shell is formatted at 120 columns (`src-tauri/rustfmt.toml`), and `tauri-build` needs the web UI
  and the sidecar in place before it compiles: `pnpm build`, `pnpm --filter @grenier/desktop build` and
  `pnpm --filter @grenier/desktop sidecar`.
- `pnpm demo` serves the desktop UI at http://localhost:1420 against a throwaway daemon and team store filled with
  made-up data (`scripts/demo.ts`); laibe's `grenier:screenshots` captures the site's screenshots from it. A screen is
  picked by the URL's hash, as `#knowledge` or `#knowledge/<record id>`.
- The desktop app bundle: `pnpm build`, `pnpm --filter @grenier/desktop sidecar [--target <triple>]` (downloads Node's
  official build, checked against the SHA-256 pinned in `apps/desktop/scripts/prepare-sidecar.mjs`), then
  `pnpm --filter @grenier/desktop tauri build`. CI builds its web UI and sidecar and tests the shell; releases build
  it for macOS, Linux and Windows (`docs/RELEASE.md`).
- Tests are in `tests/`: `unit/<package>` per workspace, `e2e` against the built CLI, `agents` with real agents,
  `fixtures` for recorded data, `support` for shared helpers.
  Unit tests import a package through its public entry (`@grenier/core`, `@grenier/store/sqlite`). Test what matters,
  as unit tests: the core logic, data handling, security, money and the usage statistics. `e2e` is a few smoke tests
  of the built CLI, for what a unit test cannot reach.
- CI is `.forgejo/workflows/ci.yml`, on git.laibe.cc: one `check` job on every push, as in Kestrel and Statim. It
  installs Tauri's Linux packages, Rust and the shell tools, builds the desktop UI and sidecar, then runs Format
  (Biome, rustfmt, shfmt), Lint (Biome, Clippy, shellcheck, the audit, the version files), Types, Tests (Vitest, then
  `cargo test`) and E2e. `nightly.yml` runs Types and Tests on the Mac before it tags a release when main has changed,
  and `release.yml` builds and publishes it on `github.com/alaibe/grenier` (`docs/RELEASE.md`). The nightly's version
  commit (author `nightly@git.laibe.cc`) skips CI's job, as in Kestrel and Statim. Each home-linux job that builds
  keeps cargo's registry, its Rust builds and the pnpm store in the runner's `/cache` (its Caches step; homeserver's
  AGENTS.md › ci-cache), and the release's Linux and Windows builds run side by side. A job that runs apt points it at
  fr.archive.ubuntu.com first, as in Kestrel and Statim: archive and security.ubuntu.com crawl from the home server.
  Tests run the same on every system: no test is skipped, or expects something else, by platform; one that can't is
  rewritten or deleted.
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
  (they are stored with the model's name).
- The team store applies a change field by field, in the order it receives them, and numbers each one; the editor's
  save sends `check`, so a field someone changed since `baseVersion` comes back as a conflict for the person to settle.
  The store names the sender as a record's author and stamps its time.
- No test touches the real `~/.grenier` or `~/.claude`: set `GRENIER_HOME` to a temporary directory, and pass a
  temporary home to what installs skills and servers. As a backstop, the unit tests run with `HOME` pointed at a
  throwaway folder (`tests/support/home.ts`).
- Prices live only in `packages/log/prices.toml` (overridable under `[prices]` in config.toml). Never write a price
  anywhere else.
- Every package is private until the release workflow publishes it; the name is settled (Grenier).
- The version is in six files kept equal by `scripts/version.ts`; change them together (`check` says when they differ).
- The site, `grenier.laibe.cc`, and its user guide live in the laibe repository (`../laibe/content/grenier/guide`).
  When a change alters how Grenier is used, update the guide there; a new or renamed config key gets its line in
  `configuration.md`. Outside code, write `\<word>`: the site drops a bare `<word>`.
