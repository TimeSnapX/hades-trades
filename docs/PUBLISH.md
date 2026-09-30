# Publishing Hades Trades (any bot, any session)

Live site: https://timesnapx.github.io/hades-trades/ (GitHub Pages, repo
`TimeSnapX/hades-trades`, branch `main`, folder `/`).

Rules:
- **The box never pushes to GitHub.** Don't use the box's `gh`/git remote or the
  GitHub connector. All pushes go from Jarrad's Windows PC **Kenny**
  (machineId `0b41e8e4-9580-46f8-842f-49e0ed41d642`), run through Shell with that machineId.
  `gh` there is logged in as TimeSnapX, and git uses HTTPS.
- Kenny runs Windows PowerShell 5. Chain commands with `;` (not `&&`) and check
  `$LASTEXITCODE`. **Never write file contents with PowerShell** (`Set-Content`,
  `Out-File`, `>`, `echo >`): it adds BOMs and mojibake. Files only reach Kenny
  through CopyFromBox, and only `tar` touches them after that.
- Source of truth: the repo `/workspace/hades-trades` on the box, including its `.git`,
  plus the canonical log `/home/box/hades/trades.json`. Kenny only holds a temporary
  copy, which you delete afterwards.

## 1. Log the trade (box)

```bash
node /home/box/hades/add-trade.mjs --from-tx <signature> --token SYM \
  --reason "why" [--snapshot '{"liquidity_usd":..,"volume24h_usd":..,"age_hours":..,"top10_pct":..,"rugcheck_score":..,"filters_passed":[..],"filters_failed":[..]}'] \
  [--exit-reason stop] [--targets real]
node /home/box/hades/add-trade.mjs --validate
```
(Exit code 3 means that tx is already logged. See `--help` and SCHEMA.md.)

## 2. Package (box)

```bash
bash /home/box/hades/package-for-kenny.sh
```
This validates the file, copies it to `data/trades.json`, runs the encoding check
and unit tests, commits on the box, and writes `/workspace/hades-trades-publish.tar`.
It prints the commit hash, so note it down.

## 3. Copy to Kenny

CopyFromBox `box_path=/workspace/hades-trades-publish.tar` to
`computer_path=C:\Users\kenny\hades-trades-publish.tar` with machineId
`0b41e8e4-9580-46f8-842f-49e0ed41d642`.

## 4. Push from Kenny (Shell with machineId, one call)

```powershell
cd C:\Users\kenny; if (Test-Path C:\Users\kenny\hades-trades-publish) { Remove-Item -Recurse -Force C:\Users\kenny\hades-trades-publish }; New-Item -ItemType Directory C:\Users\kenny\hades-trades-publish | Out-Null; tar -xf C:\Users\kenny\hades-trades-publish.tar -C C:\Users\kenny\hades-trades-publish; cd C:\Users\kenny\hades-trades-publish\hades-trades; git config core.autocrlf false; git config core.filemode false; git log -1 --format="%H %s"; git push origin main; "push exit: $LASTEXITCODE"
```
- Check that the printed hash matches step 2 and that you see `push exit: 0`.
- If the push is rejected (non-fast-forward), **stop and report it**. Never
  force-push. Someone changed GitHub directly, so the box repo has to fetch and
  merge that change first, and the user must agree to that.

## 5. Verify (Kenny)

```powershell
gh api repos/TimeSnapX/hades-trades/pages/builds/latest --jq ".status,.commit"; curl.exe -s -o NUL -w "%{http_code}`n" https://timesnapx.github.io/hades-trades/; curl.exe -s "https://timesnapx.github.io/hades-trades/data/trades.json?nocache=$(Get-Random)" | Select-String -Pattern '"updated_aest"'
```
(Keep jq expressions free of quotes: PowerShell 5 mangles nested quotes.)
Repeat every 20-30 s until the status shows `built` for the new commit. Pages
usually takes 30-90 s. Then run the optional live check from the box:
`node /workspace/hades-trades/tests/live-smoke.mjs https://timesnapx.github.io/hades-trades/`.

## 6. Clean up Kenny

```powershell
cd C:\Users\kenny; Remove-Item -Recurse -Force C:\Users\kenny\hades-trades-publish; Remove-Item -Force C:\Users\kenny\hades-trades-publish.tar; "cleaned: $(-not (Test-Path C:\Users\kenny\hades-trades-publish))"
```

## Notes
- The page reads `data/trades.json` and also shows **live** on-chain activity that is
  not in the log yet ("on-chain activity not yet logged"). A publish delay therefore
  never hides a trade, but the trade shows without a reason or snapshot until it is logged.
- Browsers may keep an old `data/trades.json` for a short while. The service worker
  is network-first, and the app fetches `data/trades.json?t=<now>` with `cache: "no-store"`.
- git on Windows writes `NativeCommandError` noise to stderr even when a push works.
  Trust `push exit: 0` and the `main -> main` line instead.
- First-time setup (already done on 2026-09-30): `gh repo create TimeSnapX/hades-trades --public`,
  push, then `gh api -X POST repos/TimeSnapX/hades-trades/pages -f "source[branch]=main" -f "source[path]=/"`.
