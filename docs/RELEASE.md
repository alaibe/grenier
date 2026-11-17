# Releasing Grenier

A release is a `v*` tag. The rest happens on git.laibe.cc's runners and on GitHub:

1. **Tag.** Every night at 22:00 in Paris (21:00 UTC), `.forgejo/workflows/nightly.yml` looks for commits on main since
   the last `v*` tag that change what ships: anything outside `.forgejo`, `docs`, `tests`, `bench` and the top-level
   notes. With some, the Mac runs `pnpm test`, moves a version that's already tagged to its next patch
   (`node scripts/version.ts bump`) and commits it, then tags `v<version>` and pushes both over SSH as Anthony: a tag
   pushed with a job's own token starts no workflow. A version not tagged yet is tagged as it is, so the first release
   is the files' 0.1.0. Its "Run workflow" button on git.laibe.cc does the same at once.
2. **Build.** The tag starts `.forgejo/workflows/release.yml`. It waits for the push mirror to bring the tag to
   `github.com/alaibe/grenier` at the same commit, drafts a release there with the commits since the last one, and
   builds the three systems on our own runners.
3. **Publish.** Once every build passes, the workflow attaches `SHA256SUMS`, publishes the release, and writes the
   Homebrew cask (`alaibe/homebrew-tap`, `Casks/grenier.rb`) for its DMG: `brew install --cask alaibe/tap/grenier`.

Running `release.yml` by hand ("Run workflow", on any branch) builds that branch's version into a draft and stops
there: the way to check the builds without publishing anything. It refuses a version that's already published. The
tag's own run later finds the draft and replaces its files.

## Versions

The version is in six files: the `package.json` of `apps/cli` (what `grenier --version` prints), `apps/server` and
`apps/desktop`, and the desktop app's `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`. `node scripts/version.ts check`
prints it and fails when two files disagree; CI runs it, and a unit test checks the files too. The nightly only moves
the patch. For a minor or major version, change all six in one commit (or run `bump` and edit its result); the next
nightly tags it as it is.

## What each system gets

| System | Files | Built on |
| --- | --- | --- |
| macOS 11 or later, Apple silicon and Intel | `Grenier-<version>.dmg`, a universal app | `mac` |
| Linux x86_64 | `Grenier_<version>_amd64.deb`, `Grenier-<version>-1.x86_64.rpm`, `Grenier_<version>_amd64.AppImage` | `home-linux` |
| Windows x86_64 | `Grenier_<version>_x64-setup.exe` (NSIS) | `home-linux`, cross-built with cargo-xwin |

Each one bundles the daemon: Node's official build for its system as the sidecar, checked against the SHA-256 pinned in
`apps/desktop/scripts/prepare-sidecar.mjs` (`--target <triple>`; `universal-apple-darwin` joins both Macs' builds with
`lipo`), the CLI's bundle, and better-sqlite3 with only that system's prebuilt addon. Before uploading, the macOS and
Linux jobs start that daemon once from what they built (`grenier status` with a throwaway `GRENIER_HOME`), which loads
the addon and creates a database; on the Mac, Intel's half runs too when Rosetta is installed.

Not there yet:

- **Updates.** The app has no updater plugin, so there is no `latest.json` and no update key: an installed copy
  updates by installing the next release, or `brew upgrade`. Adding one needs the key the homeserver repository's
  `ci-secrets.sh tauri-key` makes, whose password is the owner's.
- **The CLI on npm.** `grenier` is free on npm, but nothing publishes it: that needs an npm token. The desktop app
  carries the CLI's bundle for its own daemon only.
- **Windows signing.** The installer isn't signed, so SmartScreen warns the first time it runs.

## Signing

The Mac build is made with `--no-sign`, then `apps/desktop/scripts/sign-macos.sh` signs it inside out with the
Developer ID, each step with `--options runtime --timestamp`:

1. better-sqlite3's addons in `Contents/Resources`. They come ad hoc signed; signed by the same team as the app, they
   load with library validation on.
2. `Contents/MacOS/grenier-node`, with `apps/desktop/src-tauri/node.entitlements`: `allow-jit` and
   `allow-unsigned-executable-memory`, which V8 needs under the hardened runtime. Node's own signature also carries
   `get-task-allow`, which notarization refuses; the script fails if it's still there.
3. The app.

Tauri's own signing would give every nested binary the app's entitlements and leave the addons as they came.

**Notarization** runs only when the repository's `NOTARIZE` variable (git.laibe.cc › Settings › Actions › Variables)
is `true`, as for Kestrel and Statim, which wait on the same Apple agreement. Until then the DMG is signed but not
notarized: opened from a download, macOS asks for "Open Anyway" in System Settings › Privacy & Security.

## Secrets

Grenier has none of its own. The release reads the user-level secrets Kestrel and Statim share, set with the homeserver
repository's `ci-secrets.sh`: `RELEASES_TOKEN` (Contents read and write on `alaibe/grenier` and `alaibe/homebrew-tap`;
also the push mirror's password) and the `APPLE_*` ones, whose list is at the top of `release.yml`.

## Checking a build on a Mac

The Rust is `apps/desktop/src-tauri/rust-toolchain.toml`'s. Without notarizing or uploading anything:

```bash
pnpm build
pnpm --filter @grenier/desktop sidecar --target universal-apple-darwin
pnpm --filter @grenier/desktop tauri build --target universal-apple-darwin --bundles app --no-sign -- --locked
APP=apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Grenier.app
apps/desktop/scripts/sign-macos.sh "$APP" "Developer ID Application: Anthony Laibe (8N3Z3WWTK7)"
GRENIER_HOME=$(mktemp -d) "$APP/Contents/MacOS/grenier-node" "$APP/Contents/Resources/grenier/dist/grenier.js" status
```
