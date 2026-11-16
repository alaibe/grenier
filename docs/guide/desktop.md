# The desktop app

The desktop app shows what the daemon knows and lets you manage it without the command line:

- **Dashboard**: spending and prompt-cache savings over the last 7 days, answers reused, items, memories to review.
- **Sources**: add a notes folder, a calendar or a mailbox; sync or remove one.
- **Clients and scopes**: create a client token with the sources it may read (shown once), revoke one.
- **Audit log**: every read of personal data in the last 30 days, by client.
- **Review queue**: approve or reject the memories AI tools proposed.

The app runs the daemon itself when none is running, and stops it when it quits; a daemon you started with `grenier
start` is left alone. It reaches the daemon with the token in `~/.grenier/admin-token`, which only your user can read.

## Build it

On a Mac with Rust and Xcode's command-line tools:

```bash
pnpm build
pnpm --filter @grenier/desktop sidecar
pnpm --filter @grenier/desktop tauri build
```

`sidecar` downloads Node's official build for your machine, checks it against the SHA-256 pinned in
`apps/desktop/scripts/prepare-sidecar.mjs`, and gathers the daemon's files beside it.
