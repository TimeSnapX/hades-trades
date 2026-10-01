// Generates hand-checkable mock data for the tests (see tests/EXPECTED.md).
import fs from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const W = "CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f";
export const sig = (k) => ("Mock" + k).replace(/[0OIl]/g, "x").padEnd(88, "1");
export const mint = (k) => (k + "mint").padEnd(44, "1");
const snapAll = (o) => ({ liquidity_usd: null, volume24h_usd: null, age_hours: null, top10_pct: null, rugcheck_score: null, filters_passed: [], filters_failed: [], ...o });
const ALL9 = ["liquidity_100k", "volume24h_250k", "age_12h_14d", "mint_freeze_revoked", "lp_locked_or_burned", "top10_lt_25pct", "dev_insiders_lt_15pct", "not_after_pump", "rugcheck_no_warnings"];
const REAL = { rule_set: "real-run-v1", take_profit: [{ x: 1.5, sell_frac: 1 / 3 }, { x: 2, sell_frac: 1 / 3 }], trail_pct: 25, stop_x: 0.65, time_stop_hours: 6, keep_min_frac: 0, note: "real-run rules" };
function row(o) {
  const trade = o.action === "BUY" || o.action === "SELL";
  return {
    id: o.id, time_aest: o.time, action: o.action, token: trade ? o.token : "SOL", mint: trade ? mint(o.token) : null,
    sol: o.sol, tokens: trade ? o.tokens : null, usd_at_time: o.usd ?? null, fee_sol: o.fee ?? 0, fee_breakdown: null, rent_sol: o.rent ?? 0,
    price_expected: o.pe ?? null, price_filled: trade ? +(o.pf ?? (o.sol - (o.rent || 0)) / o.tokens).toPrecision(12) : null,
    tx: sig(o.id), reason: o.reason ?? `mock ${o.id}`, run: o.run,
    entry_snapshot: o.action === "BUY" ? snapAll(o.snap || {}) : null,
    exit_reason: o.action === "SELL" ? o.exit ?? null : null,
    planned_targets: o.action === "BUY" ? (o.run === "real" && o.trader !== "human" ? REAL : null) : null,
    ...(o.trader ? { trader: o.trader, trader_source: o.tsrc || "logged" } : {}),
  };
}
const A = [
  row({ id: "d1", time: "2026-09-28T10:00:00+10:00", action: "DEPOSIT", sol: 1.0, usd: 150, run: "test" }),
  row({ id: "baaa", time: "2026-09-28T10:30:00+10:00", action: "BUY", token: "AAA", sol: 0.2, tokens: 1000, fee: 0.002, run: "test", snap: { liquidity_usd: 150000, volume24h_usd: 300000, age_hours: 24, top10_pct: 20, rugcheck_score: 1, filters_passed: ALL9 } }),
  row({ id: "saaa", time: "2026-09-28T12:30:00+10:00", action: "SELL", token: "AAA", sol: 0.3, tokens: 1000, fee: 0.002, run: "test", exit: "target_1.5x", pf: 0.0003, pe: 0.000303 }),
  row({ id: "bbbb", time: "2026-09-29T20:00:00+10:00", action: "BUY", token: "BBB", sol: 0.1, tokens: 500, fee: 0.001, run: "test", snap: { liquidity_usd: 40000, volume24h_usd: 500000, age_hours: 5, filters_passed: ["volume24h_250k"], filters_failed: ["liquidity_100k", "age_12h_14d"] } }),
  row({ id: "sbbb", time: "2026-09-30T23:00:00+10:00", action: "SELL", token: "BBB", sol: 0.06, tokens: 500, fee: 0.001, run: "test", exit: "stop" }),
  row({ id: "d2", time: "2026-10-07T08:00:00+10:00", action: "DEPOSIT", sol: 0.5, usd: 60, run: "real" }),
  row({ id: "bccc", time: "2026-10-07T09:00:00+10:00", action: "BUY", token: "CCC", sol: 0.2, tokens: 2000, fee: 0.002, run: "real", snap: { liquidity_usd: 120000, volume24h_usd: 260000, age_hours: 48, top10_pct: 22, rugcheck_score: 1, filters_passed: ALL9 } }),
  row({ id: "sccc1", time: "2026-10-07T10:00:00+10:00", action: "SELL", token: "CCC", sol: 0.15, tokens: 1000, fee: 0.001, run: "real", exit: "target_1.5x" }),
  row({ id: "bddd", time: "2026-10-07T11:00:00+10:00", action: "BUY", token: "DDD", sol: 0.102, rent: 0.002, tokens: 100, fee: 0.001, run: "real" }),
  row({ id: "sccc2", time: "2026-10-07T12:00:00+10:00", action: "SELL", token: "CCC", sol: 0.08, tokens: 1000, fee: 0.001, run: "real", exit: "stop" }),
];
const B = [
  row({ id: "d1", time: "2026-10-05T09:00:00+10:00", action: "DEPOSIT", sol: 0.2, usd: 20, run: "real" }),
  row({ id: "beee", time: "2026-10-08T09:00:00+10:00", action: "BUY", token: "EEE", sol: 0.05, tokens: 100, run: "real" }),
  row({ id: "bfff", time: "2026-10-08T10:00:00+10:00", action: "BUY", token: "FFF", sol: 0.05, tokens: 100, run: "real" }),
  row({ id: "seee", time: "2026-10-08T12:00:00+10:00", action: "SELL", token: "EEE", sol: 0.001, tokens: 100, run: "real", exit: "stop" }),
  row({ id: "sfff", time: "2026-10-08T13:00:00+10:00", action: "SELL", token: "FFF", sol: 0.01, tokens: 100, run: "real", exit: "stop" }),
  row({ id: "bggg", time: "2026-10-08T14:00:00+10:00", action: "BUY", token: "GGG", sol: 0.05, tokens: 100, run: "real" }),
];
// Scenario C (Me vs Agent, hand-checked in tests/unit.mjs and tests/e2e.mjs):
// a position mixed between the groups (agent buys, human buys more, human sells
// 1500 = all of his 1000 + 500 "crossed" from the agent's bag, agent sells the
// rest), a human loss, and one open position per group. Now = 13:00.
const C = [
  row({ id: "cd1", time: "2026-10-07T08:00:00+10:00", action: "DEPOSIT", sol: 1.0, usd: 100, run: "real", trader: "human", tsrc: "inferred" }),
  row({ id: "axb", time: "2026-10-07T09:00:00+10:00", action: "BUY", token: "XXX", sol: 0.1, tokens: 1000, fee: 0.001, run: "real", trader: "agent" }),
  row({ id: "hxb", time: "2026-10-07T09:30:00+10:00", action: "BUY", token: "XXX", sol: 0.2, tokens: 1000, fee: 0.001, run: "real", trader: "human", tsrc: "inferred" }),
  row({ id: "hxs", time: "2026-10-07T10:00:00+10:00", action: "SELL", token: "XXX", sol: 0.45, tokens: 1500, fee: 0.001, run: "real", trader: "human", tsrc: "inferred", exit: "manual" }),
  row({ id: "axs", time: "2026-10-07T10:30:00+10:00", action: "SELL", token: "XXX", sol: 0.02, tokens: 500, fee: 0.001, run: "real", trader: "agent", exit: "stop" }),
  row({ id: "hyb", time: "2026-10-07T11:00:00+10:00", action: "BUY", token: "YYY", sol: 0.1, tokens: 100, fee: 0.001, run: "real", trader: "human", tsrc: "inferred" }),
  row({ id: "hys", time: "2026-10-07T11:30:00+10:00", action: "SELL", token: "YYY", sol: 0.05, tokens: 100, fee: 0.001, run: "real", trader: "human", tsrc: "inferred", exit: "manual" }),
  row({ id: "azb", time: "2026-10-07T12:00:00+10:00", action: "BUY", token: "ZZZ", sol: 0.1, tokens: 100, fee: 0.001, run: "real", trader: "agent" }),
  row({ id: "hwb", time: "2026-10-07T12:30:00+10:00", action: "BUY", token: "WWW", sol: 0.1, tokens: 100, fee: 0.001, run: "real", trader: "human", tsrc: "inferred" }),
];
const doc = (trades) => ({ schema_version: 1, wallet: W, gmgn: `https://gmgn.ai/sol/address/${W}`, real_run_start_aest: "2026-10-06T21:12:00+10:00", updated_aest: "2026-10-07T12:30:00+10:00", trades });
// DDD candles (SOL per token), 5-minute, 11:00-12:55 AEST on 7 Oct.
const t0 = Date.parse("2026-10-07T11:00:00+10:00") / 1000;
const candles = [];
for (let i = 0; i < 24; i++) {
  const t = t0 + i * 300;
  let o = 0.001, h = 0.001, l = 0.001, c = 0.001;
  if (i >= 5 && i <= 8) { h = 0.001; l = 0.0007; c = 0.0008; o = 0.0009; }
  if (i >= 9 && i <= 20) { const v = 0.001 + (i - 9) * (0.0002 / 11); o = v; h = v; l = v; c = v; }
  if (i === 21) { o = 0.0012; h = 0.0016; l = 0.0012; c = 0.0015; }
  if (i >= 22) { o = 0.0015; h = 0.0015; l = 0.0014; c = 0.0015; }
  candles.push([t, o, h, l, c, 10]);
}
fs.writeFileSync(dir + "mock-a.json", JSON.stringify(doc(A), null, 2) + "\n");
fs.writeFileSync(dir + "mock-b.json", JSON.stringify(doc(B), null, 2) + "\n");
fs.writeFileSync(dir + "mock-c.json", JSON.stringify(doc(C), null, 2) + "\n");
fs.writeFileSync(dir + "ohlcv-ddd.json", JSON.stringify({ data: { attributes: { ohlcv_list: [...candles].reverse() } } }) + "\n");
console.log("fixtures written");
