# Grenier

One store for what a team and its AI agents learn: answers about the code, conventions, decisions, meetings, tasks and
docs, as typed records linked to each other and to the code they came from. Agents read and write it over MCP; people
use the desktop app. Every machine keeps a full copy and works offline, and the shared store runs in your team's own
Cloudflare account. Free and open source (MIT), for macOS, Linux and Windows.

[Guide](https://grenier.laibe.cc/guide) · [Download](https://grenier.laibe.cc/download) ·
[Security](https://grenier.laibe.cc/guide/security)

## Install

```bash
brew install --cask alaibe/tap/grenier    # macOS: the app, its daemon and the grenier command
```

On Linux, the `.deb` and `.rpm` on the [download page](https://grenier.laibe.cc/download) install the app and
`/usr/bin/grenier`; the Windows installer puts it on your PATH. From source:

```bash
pnpm install && pnpm build && npm install --global ./apps/cli
```

## Usage

Open the app. On its MCP screen, add Grenier to Claude Code, Cursor or Codex: their agents recall and remember
through it. On its Team screen, start a team in your own Cloudflare account, or join one from an invite link.

To count what an agent costs, run it through Grenier:

```bash
grenier run -- claude
```

## Development

Requirements:

- Node.js 22 (`.node-version`, the version the app bundles to run its daemon) and pnpm 10
- Rust (`rust-toolchain.toml`) for the desktop app
- On Linux, [Tauri's system libraries](https://v2.tauri.app/start/prerequisites/#linux) (WebKitGTK 4.1)

```bash
pnpm install
cd apps/desktop && pnpm tauri dev    # builds the CLI and the daemon's sidecar first, then opens the app
```

`AGENTS.md` lists the checks CI runs.

## License

[MIT](LICENSE).
