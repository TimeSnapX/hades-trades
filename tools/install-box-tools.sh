#!/usr/bin/env bash
# Install the Hades tools on the shared box from this repo:
#   /home/box/hades/add-trade.mjs, lib/{schema.js,parse-tx.js}, package-for-kenny.sh, PUBLISH.md
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/home/box/hades
mkdir -p "$DEST/lib"
cp "$REPO/tools/add-trade.mjs" "$DEST/add-trade.mjs"
cp "$REPO/js/schema.js" "$REPO/js/parse-tx.js" "$DEST/lib/"
printf '{"type":"module"}\n' > "$DEST/lib/package.json"
cp "$REPO/tools/package-for-kenny.sh" "$DEST/package-for-kenny.sh"
cp "$REPO/docs/PUBLISH.md" "$DEST/PUBLISH.md"
cp "$REPO/docs/SCHEMA.md" "$DEST/SCHEMA.md"
chmod +x "$DEST/add-trade.mjs" "$DEST/package-for-kenny.sh"
echo "installed to $DEST"
