#!/usr/bin/env bash
# Captures one kind of screenshot from the running demo (pnpm demo): `site` writes grenier.laibe.cc's into $SITE_CHECKOUT.
set -euo pipefail

usage() {
    echo "usage: SITE_CHECKOUT=path/to/laibe screenshots/capture.sh site" >&2
    exit 1
}

[ $# -eq 1 ] || usage
[ "$1" = site ] || usage
cd "$(dirname "$0")/.."

[ -n "${SITE_CHECKOUT:-}" ] && [ -d "$SITE_CHECKOUT/public/sites" ] || {
    echo "SITE_CHECKOUT must be a checkout of the laibe repository." >&2
    exit 1
}
OUT="$SITE_CHECKOUT/public/sites/grenier/screenshots"
mkdir -p "$OUT"

DEMO="${DEMO_URL:-http://localhost:1440}"
curl -fsS -o /dev/null --max-time 10 "$DEMO/demo" || {
    echo "No demo at $DEMO/demo. Start it with pnpm demo, or set DEMO_URL." >&2
    exit 1
}

if [ -z "${CHROME:-}" ]; then
    for candidate in chrome-headless-shell chromium google-chrome-stable google-chrome \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
        CHROME=$(command -v "$candidate" || true)
        [ -z "$CHROME" ] || break
    done
fi
[ -n "${CHROME:-}" ] && [ -x "$CHROME" ] || {
    echo "No Chrome found. Set CHROME to a Chrome, Chromium or chrome-headless-shell binary." >&2
    exit 1
}

node screenshots/capture.ts screenshots/site.yaml "$DEMO" "$OUT" "$CHROME"
