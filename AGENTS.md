# Grenier

A team's shared memory for people and their AI agents: a pnpm workspace in TypeScript (`apps/cli`, `apps/server`,
`packages/*`) and a Tauri desktop app (`apps/desktop`).

## Checks

- CI runs these and every commit must pass them: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`,
  and `shfmt -d -i 4 -ci -bn` and `shellcheck -S warning` on the shell scripts.
- When `apps/desktop/src-tauri` changes: `pnpm build && pnpm --filter @grenier/desktop build && pnpm --filter @grenier/desktop sidecar`,
  then `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` there.
- `pnpm test:agents` runs by hand when the proxy, the MCP tools or `bench/` change: CI has no Claude Code.

## Rules

- Nothing leaves the machine by default: the team store is opt-in, and the desktop app's usage statistics send only
  what `usage.rs` lists, until the person turns them off.
- The daemon listens on `127.0.0.1` only, and every endpoint but the proxy needs a token.
- Keys and auth headers are forwarded, never stored, logged or shared. The keys a person types for a shared MCP server
  go only into their own agents' configs.
- The team store never holds file contents, prompts or keys, and `me` records leave sealed.
- The domain's rules live in `@grenier/core` and every side calls them: `recordProblem`, `memberMay` and `untrusted`.
  An agent writes only in Me; a routine runs only as its admin and its machine's rules allow.
- `@grenier/core` and `@grenier/store` also run on Cloudflare Workers: Node-only code goes in their `/node` and
  `/sqlite` entries.
- A schema change is a new migration from `pnpm db:generate` (the team store's: `pnpm --filter @grenier/server db:generate`),
  never an edit to a shipped one.
- Tests run the same on every system and never touch the real `~/.grenier` or `~/.claude`.
- Dependencies are exact versions. Prices live only in `packages/log/prices.toml`.
- No backward compatibility: delete what is obsolete, with no shim, fallback or migration of old data.
- A comment is one line that says why, or there is none.
- The user guide is `../laibe/content/grenier/guide`: update it when usage changes.

## Design

- The desktop app follows the laibe design system as of its 2026-11-26 changelog entry (`git.laibe.cc/anthony/design`)
  with the `gold` accent. Before a UI change, read its `principles.md` and the component pages it touches.
- `apps/desktop/src/laibe/` is a copy of the system's CSS: replace it when the system changes, never edit it here.
  Components in `src/ui/` are thin wrappers, one per system page; views pass a variant, never a colour or type.
- The window is the system's app shell, with places and items in the URL's hash. Every action is a command in
  `shell/commands.tsx`, which drives the keys, the ⌘K palette, the `?` overlay and the status bar's hints.
- The site's screenshots come from `screenshots/capture.sh site` (the list is `screenshots/site.yaml`), weekly in the
  Screenshots workflow, per the system's `patterns/screenshots.md`.
