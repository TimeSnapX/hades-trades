#!/usr/bin/env bash
# Package the canonical trade log for publishing from Kenny (see PUBLISH.md).
#   bash /home/box/hades/package-for-kenny.sh
# 1. validates /home/box/hades/trades.json (schema v1)
# 2. copies it to /workspace/hades-trades/data/trades.json and runs the checks
# 3. commits on the box (no push: the box never pushes to GitHub)
# 4. writes /workspace/hades-trades-publish.tar (whole repo incl. .git) for CopyFromBox
set -euo pipefail
SRC="${HADES_TRADES:-/home/box/hades/trades.json}"
REPO="${HADES_REPO:-/workspace/hades-trades}"
OUT="${HADES_TAR:-/workspace/hades-trades-publish.tar}"
node /home/box/hades/add-trade.mjs --file "$SRC" --validate
cp "$SRC" "$REPO/data/trades.json"
cd "$REPO"
node tools/check-encoding.mjs
node tests/unit.mjs > /dev/null
ROWS=$(node -e 'const d=JSON.parse(require("fs").readFileSync("data/trades.json","utf8"));console.log(d.trades.length+" rows, updated "+d.updated_aest)')
git add data/trades.json
if git diff --cached --quiet; then
  echo "trades.json unchanged since the last commit"
else
  git -c user.name=TimeSnapX -c user.email=timesnapx@gmail.com commit -q -m "data: trades.json ($ROWS)"
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "WARNING: uncommitted source changes in $REPO (not included in the push):"; git status --short --untracked-files=no
fi
rm -f "$OUT"
tar --exclude="$(basename "$REPO")/test-results" --exclude="$(basename "$REPO")/node_modules" -cf "$OUT" -C "$(dirname "$REPO")" "$(basename "$REPO")"
echo "commit: $(git rev-parse HEAD) ($(git log -1 --format=%s))"
echo "tar:    $OUT ($(du -h "$OUT" | cut -f1), sha256 $(sha256sum "$OUT" | cut -c1-16))"
echo "next:   CopyFromBox $OUT -> Kenny C:\\Users\\kenny\\hades-trades-publish.tar, then run the PowerShell block in PUBLISH.md"
