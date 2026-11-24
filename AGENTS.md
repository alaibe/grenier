# Working in this repository

Before you finish: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`. When `apps/desktop/src-tauri` changes, also run `pnpm build && pnpm --filter @grenier/desktop build && pnpm --filter @grenier/desktop sidecar`, then `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` there. Run `pnpm test:agents` by hand when the proxy, the MCP tools or `bench/` change: CI has no Claude Code.

## Hard rules

- The daemon binds to `127.0.0.1` only, and its endpoints need a client token, except the proxy path `grenier run` uses.
- API keys and auth headers are forwarded, never stored, logged or sent to the team store.
- Nothing leaves the machine by default: the team store is opt-in. The one exception is the desktop app's usage statistics (`usage.rs`), which send a screen's url from the fixed list and the display's size, nothing else.
- The team store never holds file contents, prompts or keys: every record passes `recordProblem` on both sides, and `me` records are sealed before they leave.
- An agent's record leaves the machine only once its person approved it through MCP elicitation (`remember` in `packages/index/src/records.ts`).
- A member who is not an admin writes only in their Me folder, their agents' memories in a repository's folder, and the run fields of a request their machine ran: `memberMay` in `packages/core/src/records.ts`, checked by the team store and before every local write.
- Records reach an MCP client only through `deliver`; a new read path's test goes in `tests/unit/personal/scopes.test.ts`, against every scope.
- A shared skill, MCP server or routine installs or runs only once this machine's person approved its hash. A routine's read-only mode is enforced twice, by `--tools` and by the proxy's `RunGuard`.
- The proxy changes a request body only behind an opt-in flag, and logs every change.
- Dependencies are exact versions.
- Tests never touch the real `~/.grenier` or `~/.claude`: set `GRENIER_HOME` to a temporary directory and pass a temporary home.
- Prices live only in `packages/log/prices.toml`.

## Conventions

- Comments are one line, and only where the code can't say why.
- Delete what is obsolete outright: no compatibility layer, fallback or migration of old data, config or formats.
- `src/usage/tracker.ts`, `src/usage/use-usage.ts`, `src-tauri/src/usage-vectors.json` and the core of `usage.rs` in `apps/desktop` are shared byte for byte with Kestrel and Statim: change all three apps together.
- `@grenier/core` and `@grenier/store` also run on Cloudflare Workers: Node-only code goes in `@grenier/core/node` or `@grenier/store/sqlite`.
- A schema change: edit `packages/store/src/schema.ts`, run `pnpm db:generate`, list the new SQL file in `packages/store/src/migrations.ts`. A shipped migration never changes.
- Tests run the same on every system: none is skipped, or expects something else, by platform.
- The user guide is `../laibe/content/grenier/guide`: update it when usage changes, and give a new config key its line in `configuration.md`.
- The maintainer's own material (launch posts, demo scripts, images) goes in the gitignored `priv/`.
