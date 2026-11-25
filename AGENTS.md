# Grenier

A team's shared memory for people and their AI agents: a pnpm workspace in TypeScript (`apps/cli`, `apps/server`,
`packages/*`) and a Tauri desktop app in Rust (`apps/desktop`).

## Checks

- Before you finish: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`. CI also runs
  `shfmt -d -i 4 -ci -bn` and `shellcheck -S warning` on the shell scripts.
- When `apps/desktop/src-tauri` changes, also run `pnpm build && pnpm --filter @grenier/desktop build && pnpm --filter @grenier/desktop sidecar`,
  then `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` there.
- Run `pnpm test:agents` by hand when the proxy, the MCP tools or `bench/` change: CI has no Claude Code.

## Rules

- The daemon binds to `127.0.0.1` only, and its endpoints need a client token, except the proxy path `grenier run` uses.
- API keys and auth headers are forwarded, never stored, logged or sent to the team store.
- The keys a person types to install a shared MCP server go only into that server's entry in their own Claude Code config (`serverEntry` in `apps/cli/src/installs.ts`): never into the store, an approval, the team store or a log.
- Nothing leaves the machine by default: the team store is opt-in. The one exception is the desktop app's usage statistics (`usage.rs`), on until the person turns them off in Settings, which send a screen's url and title from the fixed list, the display's size, Grenier's version, the system's name and a random id, nothing else. An admin's search of skills.sh or the MCP Registry sends only the words typed (`apps/cli/src/catalog.ts`).
- The team store never holds file contents, prompts or keys: every record passes `recordProblem` on both sides, and `me` records are sealed before they leave.
- An agent's record or request leaves the machine only once its person approved it through MCP elicitation (`remember` in `packages/index/src/writes.ts`). A routine's run, with nobody there to ask, writes under the approval its machine's person gave that routine.
- A member who is not an admin writes only in their Me folder, their agents' memories in a repository's folder, and the run fields of a request their machine ran: `memberMay` in `packages/core/src/records.ts`, checked by the team store and before every local write.
- Records and summaries reach an MCP client only redacted and marked untrusted, through `untrusted` in `packages/core/src/policy.ts`, which `deliver` and the summaries in `packages/index/src/reads.ts` call, as does the team store's own MCP; a new read path's test goes in `tests/unit/index/scopes.test.ts`, against every scope.
- A shared skill, MCP server or routine installs or runs only once this machine's person approved its hash. A routine runs in its machine's work folder (`machine.workdir`). Its read-only and shadow modes are enforced twice: by `--tools` and the proxy's `RunGuard` for Claude Code, by Codex's read-only sandbox and the same `RunGuard` for Codex. In `limited` and `on`, Claude Code's auto mode (`--permission-mode auto`) or Codex's workspace-write sandbox judges each call, and `RunGuard` counts `limited`'s actions.
- The proxy changes a request body only behind an opt-in flag, and logs every change.
- Dependencies are exact versions.
- Tests never touch the real `~/.grenier` or `~/.claude`: set `GRENIER_HOME` to a temporary directory and pass a temporary home.
- Tests run the same on every system: none is skipped, or expects something else, by platform.
- Prices live only in `packages/log/prices.toml`.
- `@grenier/core` and `@grenier/store` also run on Cloudflare Workers: Node-only code goes in `@grenier/core/node` or `@grenier/store/sqlite`.
- A schema change: edit `packages/store/src/schema.ts`, run `pnpm db:generate`, list the new SQL file in `packages/store/src/migrations.ts`. A shipped migration never changes.
- `src/usage/tracker.ts`, `src/usage/use-usage.ts`, `src-tauri/src/usage-vectors.json` and the core of `usage.rs` in `apps/desktop` are shared byte for byte with Kestrel and Statim: change all three apps together.
- Delete what is obsolete outright: no compatibility layer, fallback or migration of old data, config or formats.
- A comment is one line, and only where the code can't say why.
- The user guide is `../laibe/content/grenier/guide`: update it when usage changes, and give a new config key its line in `configuration.md`.
- grenier.laibe.cc's screenshots come from `screenshots/`: the shots are listed in `site.yaml`, `capture.sh site`
  takes them from `pnpm demo`, and the weekly `Screenshots` workflow commits them to laibe (the system's
  `patterns/screenshots.md`). Never capture one by hand.
- The maintainer's own material (launch posts, demo scripts, images) goes in the gitignored `priv/`.

## Design

- The desktop app follows the laibe design system (`git.laibe.cc/anthony/design`) as of its 2026-11-25 changelog
  entry, with the `gold` accent (`data-accent="gold"` in `apps/desktop/index.html`). Before changing its UI, read the
  system's `principles.md` and the `components/` pages the change touches.
- Grenier's icon is the system's icon template with Grenier's glyph, a roof and its lit round window:
  `apps/desktop/src-tauri/icons/icon.svg` is the source, the other sizes come from `pnpm tauri icon`, and `Mark` in
  `ui.tsx` is its flat form.
- `apps/desktop/src/laibe/` is a copy of the system's `tokens/tokens.css` and `tokens/tailwind.css`: replace both
  files when the system changes, never edit them here. Biome ignores the folder so they stay byte for byte.
- Use the system's colour names only (`bg`, `panel`, `fg`, `muted`, `accent`, `on-accent`, `danger`, `success`…).
  The interface is in `font-mono`, content in `font-sans`. A status is a `Status` tag, never a colour alone.
- The window is the system's app shell (`patterns/app-shell.md`) in `App.tsx`: title bar, banner, sidebar,
  content and status bar, each scrolling on its own. A new place gets an icon in `PLACE_ICONS` (`palette.tsx`) and
  shows in the ⌘K palette with its ⌘ number; an app-wide command goes in `commands` in `App.tsx`.
- Success after an action is a toast (`Notice` sends it); a problem stays on the page. Anything irreversible asks
  through `ConfirmButton`, which opens a `Dialog`. Buttons take their icon by the system's label-and-icon rule.
