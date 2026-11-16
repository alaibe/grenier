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

## Comments

Keep comments to the minimum. Add one only when it explains something the code cannot make clear; never restate the
code.

## Layout

- `packages/*` are libraries, `apps/*` are what runs: `apps/cli` is the `grenier` command and, from phase 1, the daemon.
- Tests are in `tests/`: `unit/<package>` per workspace, `e2e` against the built CLI, `fixtures` for recorded data.
  Unit tests import a package through its public entry (`@grenier/core`, `@grenier/store/sqlite`).
- CI is `.forgejo/workflows/ci.yml`, on git.laibe.cc.

## Things that are not obvious from the code

- Workspace packages are TypeScript source: their `exports` point at `src/*.ts`, and nothing builds them on their own.
  The CLI is bundled by `apps/cli/build.mjs`; better-sqlite3 stays outside the bundle, so it is also a dependency of
  `apps/cli`.
- `@grenier/core` and `@grenier/store` must run on Cloudflare Workers too. Node-only code goes in a subpath
  (`@grenier/core/node`, `@grenier/store/sqlite`); Biome refuses a Node import anywhere else in those two packages.
- Only `packages/store/src/sqlite.ts` imports better-sqlite3, and `packages/*` never import `apps/*`. Biome enforces
  both.
- The schema moves forward by migration: a new `packages/store/migrations/NNNN_name.sql`, listed in
  `packages/store/src/migrations.ts`. A shipped migration never changes. SQL files are imported as text (esbuild's
  text loader, a Vitest plugin, `types/sql.d.ts`).
- No test touches the real `~/.grenier`: set `GRENIER_HOME` to a temporary directory.
- Dependencies are exact versions, and pnpm refuses releases younger than 7 days (`pnpm-workspace.yaml`). Install
  scripts run only for the packages listed there.
- Every package is private until the name is settled (Open decisions, **Name**).
