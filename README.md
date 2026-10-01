# Hades Trades

A read-only, phone-first dashboard for the trades in Jarrad's Solana wallet, split into
**Agent** (Hades, his memecoin bot) and **Me** (Jarrad trading manually in Phantom), with a
Me vs Agent comparison. Wallet: `CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f`
([GMGN](https://gmgn.ai/sol/address/CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f)).

Live: https://timesnapx.github.io/hades-trades/

- Plain static site with no build step, installable as a PWA (scope `/hades-trades/`).
  The service worker only caches same-origin files and never caches API calls.
- It has no wallet connect, no keys and no signing. It only reads public data.
- The trade log is `data/trades.json`, documented in [docs/SCHEMA.md](docs/SCHEMA.md).
- Live data is read in the browser:
  - SOL balance and signatures: public RPCs (publicnode, then the others)
  - SPL and Token-2022 balances: `getTokenAccountsByOwner`, falling back to Jupiter holdings
  - prices: DexScreener, falling back to Jupiter price
  - SOL/USD/AUD: Coinbase, then CoinGecko, then Binance with open.er-api
  - candles for MFE/MAE and the rules simulation: GeckoTerminal
- Responses are cached in localStorage and fall back to stale copies. Rate limits
  trigger cooldowns, and every source shows a status chip.
- Updates: [docs/PUBLISH.md](docs/PUBLISH.md). Trades are added on the box with
  `/home/box/hades/add-trade.mjs` and published from the PC "Kenny".

## Layout
`index.html`, `css/`, and in `js/`:
- `app.js`: the UI
- `stats.js`: pure analytics
- `sources.js`: API access
- `charts.js`: SVG charts
- `schema.js`, `parse-tx.js`: shared with the CLI

Also:
- `sw.js`, `manifest.webmanifest`, `icons/`
- `tools/`: add-trade CLI, packaging, encoding check, seed builder
- `tests/`: unit, Playwright e2e with mocked APIs, add-trade, live smoke test

## Tests
```bash
node tests/unit.mjs          # analytics vs hand-computed values
node tests/e2e.mjs           # headless Chromium, 390x844, all APIs mocked
node tests/add-trade.test.mjs [--live]
node tests/live-smoke.mjs [url]
node tools/check-encoding.mjs
```
