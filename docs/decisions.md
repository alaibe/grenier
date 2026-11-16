# Decisions

One line per decision the plan left open: date, decision, reason. Newest last.

- 2026-11-16 · The origin is `ssh://git@git.laibe.cc:2222/anthony/grenier.git`, private until the Name decision is made; a GitHub mirror comes later. · Same home as the other projects; nothing public before the name is checked.
- 2026-11-16 · CI is `.forgejo/workflows/ci.yml` on the `home-linux` runner, not GitHub Actions; the GitHub mirror gets no workflow of its own. · The origin is Forgejo, and kestrel runs its CI the same way. Forgejo reads the same workflow syntax.
- 2026-11-16 · Node 22 in `.node-version` and CI, `engines` `>=22.12`. · The plan's LTS; newer Node works for local development.
- 2026-11-16 · Exact versions, a committed lockfile, `--frozen-lockfile` in CI, pnpm's `minimumReleaseAge` of 7 days, install scripts allowed for esbuild only, actions pinned to a commit. · Security rule 10, and a compromised release is usually pulled within days.
- 2026-11-16 · better-sqlite3's node-gyp build is skipped (`ignoredBuiltDependencies`). · Version 13 ships N-API prebuilds for every platform; the build needed a compiler and changed nothing.
- 2026-11-16 · Workspace packages export their TypeScript source (`exports` point at `src/*.ts`); esbuild bundles the CLI, Vitest runs the tests, and Wrangler will bundle the Worker. No per-package build. · One build step per app instead of one per package; `tsc` only typechecks.
- 2026-11-16 · `@grenier/core` and `@grenier/store` run anywhere (Biome's `noNodejsModules` enforces it); Node-only code is in the `@grenier/core/node` and `@grenier/store/sqlite` subpaths. · The same core has to run on Workers in phase 2.
- 2026-11-16 · Biome's `noRestrictedImports` enforces the plan's conventions: better-sqlite3 is imported only by `packages/store/src/sqlite.ts`, and `packages/*` never import `apps/*`. · A convention that is checked stays true.
- 2026-11-16 · Tests live in a top-level `tests/` (`unit/<package>`, `e2e`, `fixtures`), as in kestrel, and unit tests import packages through their public entries. · One Vitest config, and the tests exercise what other packages see.
- 2026-11-16 · A package is created by the first task that puts code in it: phase 0 has `core`, `store` and `apps/cli`. · Empty packages would be scaffolding with nothing to test.
- 2026-11-16 · `GRENIER_HOME` moves the home directory (default `~/.grenier`) and both files with it; `GRENIER_CONFIG` and `GRENIER_DB` override each file. · One variable for tests and the daemon's own files; the plan's two overrides still work.
- 2026-11-16 · No config file is written on first run: a missing file means defaults. Unknown keys are errors. Budgets have no default (no limit until set). · Defaults can change in a release without stale copies; a typo must not pass silently; spending limits are the user's call.
- 2026-11-16 · `proxy.upstream_anthropic` and `team.url` must be https, or http to a loopback address. · They receive API keys and the team token; local test servers still work.
- 2026-11-16 · The home directory is created 0700 and the database 0600. · It holds usage, answers and later personal data.
- 2026-11-16 · `grenier status` reads the daemon's pid from `<home>/daemon.pid`, which `grenier start` will write. · Needs no network call and no token.
- 2026-11-16 · Migrations are SQL files imported as text and recorded in a `schema_migrations` table, all pending ones in one immediate transaction; a database newer than the build is refused. · Works on D1 too (no `PRAGMA user_version`), and two processes starting at once cannot both migrate.
- 2026-11-16 · The schema is the plan's, plus STRICT tables, NOT NULL on keys and times, keys on `answer_sources` and `budgets`, indexes, full-text sync triggers, and `answer_sources` deleted with their answer. Times are Unix milliseconds. · The plan sketched columns; these keep the data consistent.
- 2026-11-16 · `answers` has `seq INTEGER PRIMARY KEY` beside `id TEXT UNIQUE`, and `answers_fts` uses `seq` as its rowid. · An external-content FTS5 index needs a stable integer rowid; VACUUM can renumber an implicit one.
- 2026-11-16 · The first migration has the phase 1 tables only; the sqlite-vec table waits for the Embedding model decision, the phase 3 tables for phase 3. · Its dimension depends on the model; a shipped migration never changes.
- 2026-11-16 · In phase 0, "built binary" is `apps/cli/dist/grenier.js`, the esbuild bundle run through `bin`, with better-sqlite3 installed beside it. · A single-file executable is the Tauri sidecar's need, in phase 3.
- 2026-11-16 · Every package is `private: true`. · Nothing can be published before the Name decision.
- 2026-11-16 · Releases will work as kestrel's: `nightly.yml` tags `v*` when main has app commits since the last tag, `release.yml` builds and publishes to a public GitHub releases repository, `docs/RELEASE.md` describes it. Added when there is something to ship. · The release path the other projects use.
- 2026-11-16 · The site lives in the laibe repository as a new site (a case in `App\Sites\Site`, `content/grenier/`, the shared `x-product.*` pages), as Kestrel's and ProofTrail's do, instead of a docs site generated from this repository's `docs/`. · One app serves every product's site.
