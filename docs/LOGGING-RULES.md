# Hades: who is the trader? (rule from 2026-10-02)

When you log a trade with `add-trade.mjs`, always pass `--trader`. The dashboard
compares **Me** (Jarrad) with **Agent** (Hades) by whose decision the trade was,
not by who clicked.

| Situation | Flag |
|---|---|
| Jarrad picked the token (from a shortlist, an Argus pick, his own idea) and you bought it | `--trader human` |
| Jarrad ordered the buy or sell ("buy X", "put it all on Y", "sell all", "sell DARK") | `--trader human` |
| Stop / target / trail / time-stop / emergency exit on a position **Jarrad picked** | `--trader human` (and the right `--exit-reason`) |
| You chose the entry yourself under your own rules (no pick or order from Jarrad) | `--trader agent` |
| Stop / target / trail / time-stop / emergency exit on **your own** position | `--trader agent` |
| Jarrad orders you to sell one of **your own** positions | `--trader human` (the row shows as "crossed"; P&L stays with Agent) |

Why exits follow the buy: P&L is matched FIFO within each group. An `agent` exit on
a position only Me holds becomes a "crossed" leg: the P&L still goes to Me, but the
sell is counted as an Agent trade. That splits one position over two columns. So a
position keeps its buyer's group for its rule-based exits, and `--exit-reason`
records which rule fired.

If you are unsure, write the pick/order in `--reason` (e.g. "User picked ...",
"User ordered sell-all") and use `--trader human`. Never leave `--trader` out: the
CLI default for BUY/SELL is `agent`.

Example:
```bash
node /home/box/hades/add-trade.mjs --from-tx <sig> --token SYM --trader human \
  --reason "User picked from Argus shortlist; ..." --snapshot '{...}' --targets real
node /home/box/hades/add-trade.mjs --from-tx <sig> --trader human --exit-reason stop \
  --reason "Hit -35% hard stop on user's pick"
node /home/box/hades/add-trade.mjs --validate
```
