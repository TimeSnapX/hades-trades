# Hades: who is the trader?

The dashboard compares **Me** (Jarrad trading himself) with **Agent** (Hades) by
who executed the trade.

| Situation | Flag |
|---|---|
| You chose the token and bought/sold it under your rules | `--trader agent` |
| Jarrad picked the token (shortlist, Argus pick, his idea) and you placed the buy | `--trader agent` (say "User picked ..." in `--reason`) |
| Jarrad ordered the buy or sell ("buy X", "put it all on Y", "sell all") and you placed it | `--trader agent` (say "User ordered ..." in `--reason`) |
| Your stop / target / trail / time-stop / emergency exit, on any position | `--trader agent` (and the right `--exit-reason`) |
| Jarrad traded himself in Phantom | `--trader human`, or leave it to `--sync-unlogged` (adds it as human/inferred) |

`--trader agent` is the CLI default for BUY/SELL, so passing it is optional but
clearer. If you exit a position Jarrad bought himself, the sell shows as "crossed"
and its P&L stays with Me (FIFO per group).

(On 2026-10-02 the user-picked rows were briefly switched to `human`; that was
reverted the same day. This file is the current rule.)

Example:
```bash
node /home/box/hades/add-trade.mjs --from-tx <sig> --token SYM --trader agent \
  --reason "User picked from Argus shortlist; ..." --snapshot '{...}' --targets real
node /home/box/hades/add-trade.mjs --from-tx <sig> --trader agent --exit-reason stop \
  --reason "Hit -35% hard stop"
node /home/box/hades/add-trade.mjs --validate
```
