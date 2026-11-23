#!/usr/bin/env bash
# Signs Grenier.app inside out: notarization refuses a bundle with anything unsigned.
set -euo pipefail

usage="usage: sign-macos.sh <Grenier.app> <identity> [keychain]"
app="${1:?$usage}"
identity="${2:?$usage}"
keychain="${3:-}"
entitlements="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/node.entitlements"

sign() {
    local args=(--force --sign "$identity" --options runtime --timestamp)
    [ -n "$keychain" ] && args+=(--keychain "$keychain")
    codesign "${args[@]}" "$@"
}

addons=0
while IFS= read -r -d '' addon; do
    sign "$addon"
    addons=$((addons + 1))
done < <(find "$app/Contents/Resources" -type f -name '*.node' -print0)
[ "$addons" -gt 0 ] || {
    echo "no native addon in $app/Contents/Resources: was the sidecar prepared?" >&2
    exit 1
}

sign --entitlements "$entitlements" "$app/Contents/MacOS/grenier-node"
sign "$app"

codesign --verify --deep --strict --verbose=2 "$app"
for binary in "$app" "$app/Contents/MacOS/grenier-node"; do
    if codesign -d --entitlements - "$binary" 2>/dev/null | grep -q get-task-allow; then
        echo "$binary carries get-task-allow; notarization would refuse it." >&2
        exit 1
    fi
done
echo "Signed $app"
