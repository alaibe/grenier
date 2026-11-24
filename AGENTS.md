# Working in this repository

Before you finish: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`. When `apps/desktop/src-tauri` changes, also run `pnpm build && pnpm --filter @grenier/desktop build && pnpm --filter @grenier/desktop sidecar`, then `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` there. Run `pnpm test:agents` by hand when the proxy, the MCP tools or `bench/` change: CI has no Claude Code.

## Hard rules

- The daemon binds to `127.0.0.1` only, and its endpoints need a client token, except the proxy path `grenier run` uses.
- API keys and auth headers are forwarded, never stored, logged or sent to the team store.
- The keys a person types to install a shared MCP server go only into that server's entry in their own Claude Code config (`serverEntry` in `apps/cli/src/installs.ts`): never into the store, an approval, the team store or a log.
- Nothing leaves the machine by default: the team store is opt-in. The one exception is the desktop app's usage statistics (`usage.rs`), on until the person turns them off in Settings, which send a screen's url and title from the fixed list, the display's size, Grenier's version, the system's name and a random id, nothing else. An admin's search of skills.sh or the MCP Registry sends only the words typed (`apps/cli/src/catalog.ts`).
- The team store never holds file contents, prompts or keys: every record passes `recordProblem` on both sides, and `me` records are sealed before they leave.
- An agent's record or request leaves the machine only once its person approved it through MCP elicitation (`remember` in `packages/index/src/records.ts`). A routine's run, with nobody there to ask, writes under the approval its machine's person gave that routine.
- A member who is not an admin writes only in their Me folder, their agents' memories in a repository's folder, and the run fields of a request their machine ran: `memberMay` in `packages/core/src/records.ts`, checked by the team store and before every local write.
- Records and summaries reach an MCP client only redacted and marked untrusted, as `deliver` in `packages/index/src/records.ts` does, and so does the team store's own MCP; a new read path's test goes in `tests/unit/personal/scopes.test.ts`, against every scope.
- A shared skill, MCP server or routine installs or runs only once this machine's person approved its hash. A routine's read-only mode is enforced twice: by `--tools` and the proxy's `RunGuard` for Claude Code, by Codex's read-only sandbox and the same `RunGuard` for Codex.
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
