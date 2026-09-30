# Hades Trades: `trades.json` schema (v1)

Canonical file: `/home/box/hades/trades.json` on the shared box. Published copy:
`data/trades.json` in this repo (served at
https://timesnapx.github.io/hades-trades/data/trades.json). Only
`/home/box/hades/add-trade.mjs` should write the canonical file; it validates every
row with `js/schema.js`, dedupes by `tx`, keeps rows sorted and writes atomically.

All times are Brisbane time (AEST, UTC+10, no DST) as ISO 8601 with an explicit
offset, for example `2026-09-29T21:13:20+10:00`. Amounts are plain JSON numbers.
Unknown values are `null`, never guessed.

## Document

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | `1` | Bump on breaking changes. |
| `wallet` | base58 | Hades agent wallet (`CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f`). |
| `gmgn` | URL | GMGN wallet page. |
| `real_run_start_aest` | ISO +10:00 | When the real-run rulebook starts (`2026-10-06T21:12:00+10:00`). Rows at/after it default to `run: "real"`. |
| `updated_aest` | ISO +10:00 | Last write by add-trade.mjs. |
| `trades` | array | Rows below, sorted by `time_aest` ascending (ties by `tx`). |

## Trade row

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique. add-trade.mjs uses `<action>-<token>-<first 8 chars of tx>`, e.g. `buy-resi-3GPJ2SL3`. |
| `time_aest` | ISO +10:00 | Block time of the transaction. |
| `action` | `BUY` \| `SELL` \| `DEPOSIT` \| `WITHDRAW` | |
| `token` | string \| `"SOL"` | Token symbol for BUY/SELL; `"SOL"` (or null) for DEPOSIT/WITHDRAW. |
| `mint` | base58 \| null | Token mint for BUY/SELL; null otherwise. |
| `sol` | number > 0 | **Exact** absolute change of the wallet's native SOL balance in this tx (lamports / 1e9). For a BUY it includes the swap, network fee, tip, platform fee and any token-account rent. For a SELL it is what arrived net of fees. |
| `tokens` | number \| null | Exact token amount bought/sold (UI units, decimals applied). |
| `usd_at_time` | number \| null | `sol` x SOL/USD at the time (see `usd_source`). |
| `usd_source` | string \| null | e.g. `kraken SOLUSD 1m close @ 2026-09-30T17:56:00+10:00`. |
| `fee_sol` | number \| null | `fee_breakdown` total: network fee + tip + platform fee. |
| `fee_breakdown` | object \| null | `{network_sol, tip_sol, platform_sol}`. `platform_sol` is detected as outflows equal to 0.85% (Phantom swap fee) of another SOL flow; null if not detected. Pool/LP/creator fees are part of the fill price, not counted here. |
| `rent_sol` | number | Rent locked (+) or refunded (-) in the wallet's token accounts by this tx. Recoverable, so it is excluded from cost basis. |
| `price_expected` | number \| null | Quoted SOL per token before the swap (from the bot's quote). Needed for slippage. |
| `price_filled` | number \| null | Effective SOL per token. BUY: `(sol - rent - network - tip) / tokens` (includes the platform fee). SELL: `(sol + rent + network + tip) / tokens` (after the platform fee). |
| `tx` | base58 | Transaction signature. Unique. Links to `https://solscan.io/tx/<tx>`. |
| `reason` | string \| null | Why the trade was made (from the bot log). |
| `run` | `test` \| `real` | Test run (until 2026-10-06 21:12 AEST) or real run. |
| `entry_snapshot` | object (BUY) \| null | See below. Required on every BUY (use nulls), null otherwise. |
| `exit_reason` | string \| null | SELL only: `target_1.5x`, `target_2x`, `target_other`, `trail`, `stop`, `time_stop`, `emergency`, `rug`, `manual`, `rebalance`. |
| `planned_targets` | object (BUY) \| null | See below. BUY only. The latest BUY of a position defines the targets the app shows. |
| `token_program` | string \| null | SPL Token (`Tokenkeg...`) or Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). |
| `verified_chain` | boolean | true when amounts came from the chain (`--from-tx` or `--verify`). |
| `unverified` | string[] | Fields that could not be verified (e.g. `price_expected`, `reason`, `usd_at_time`). |

### `entry_snapshot` (BUY rows)

```json
{
  "liquidity_usd": 47000, "volume24h_usd": 5500000, "age_hours": 8.91,
  "top10_pct": 30, "rugcheck_score": 1,
  "filters_passed": ["volume24h_250k", "mint_freeze_revoked", "lp_locked_or_burned", "rugcheck_no_warnings"],
  "filters_failed": ["liquidity_100k", "age_12h_14d", "top10_lt_25pct"],
  "source": "trades.md (Hades log)", "notes": "optional free text"
}
```

The five numbers are required keys (null if unknown). Filter names are the
real-run entry rules 4-9; a filter in neither list is "unknown":

| Name | Rule |
|---|---|
| `liquidity_100k` | Liquidity >= $100k |
| `volume24h_250k` | 24 h volume >= $250k |
| `age_12h_14d` | Token age 12 hours to 14 days |
| `mint_freeze_revoked` | Mint + freeze authority revoked |
| `lp_locked_or_burned` | LP locked or burned |
| `top10_lt_25pct` | Top 10 holders < 25% |
| `dev_insiders_lt_15pct` | Dev + insiders < 15% |
| `not_after_pump` | Price >= 30% below recent high, steady buy volume |
| `rugcheck_no_warnings` | RugCheck shows no warnings |

add-trade.mjs fills `liquidity_100k`, `volume24h_250k`, `age_12h_14d` and
`top10_lt_25pct` automatically from the numbers; the rest must be passed explicitly.

### `planned_targets` (BUY rows)

```json
{
  "rule_set": "real-run-v1",
  "take_profit": [{ "x": 1.5, "sell_frac": 0.3333 }, { "x": 2, "sell_frac": 0.3333 }],
  "trail_pct": 25, "stop_x": 0.65, "time_stop_hours": 6, "keep_min_frac": 0,
  "note": "free text"
}
```

`x` is a multiple of entry cost; `sell_frac` is the fraction of the position to
sell (null = not specified); `stop_x` 0.65 = -35%. `--targets real` inserts the
real-run rules (default for real-run BUYs). Test-run rows carry the targets
stated in trades.md (e.g. 101x, keep >= 10%, no stop).

## How the app computes things

- Cost of a BUY = `sol - rent_sol`; proceeds of a SELL = `sol + rent_sol`.
- Positions use average cost per mint; a position closes when its quantity returns
  to 0. Win/loss, win rate, profit factor, expectancy and streaks use closed positions.
- R = P&L% / 35% (the real-run hard stop).
- Wallet value = live SOL + reclaimable token-account rent + token balances x price.
- Deposited = sum of DEPOSIT minus WITHDRAW `sol`; fiat deposited uses `usd_at_time`.
- MFE/MAE and the "rules followed" simulation use GeckoTerminal candles in SOL per
  token (`currency=token`); n/a when unavailable.

## Example row

```json
{
  "id": "sell-inuink-2cvToVLX",
  "time_aest": "2026-09-29T22:03:23+10:00",
  "action": "SELL", "token": "INUINK", "mint": "9k7NgXqiJ7tvLtiB6HXdJHnKZZynFz46AB6Eg4Uwpump",
  "sol": 0.020480229, "tokens": 2862.577154, "usd_at_time": 2.4611,
  "usd_source": "kraken SOLUSD 5m close @ 2026-09-29T22:00:00+10:00",
  "fee_sol": 0.000405087,
  "fee_breakdown": { "network_sol": 0.000080001, "tip_sol": 0.000006, "platform_sol": 0.000319086 },
  "rent_sol": 0, "price_expected": null, "price_filled": 7.184515523e-6,
  "tx": "2cvToVLXx6H2VV5ABXrAVFgcAKFU2XYXcFhR2H4ghBP9PPBjnm8q11Z2hAEuS72wTpdSFsXuzZjENU1MaUm3vHjc",
  "reason": "Hit -50% stop at 0.0208 SOL (entry 0.0416); sold all",
  "run": "test", "entry_snapshot": null, "exit_reason": "stop", "planned_targets": null,
  "token_program": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "verified_chain": true,
  "unverified": ["price_expected"]
}
```
