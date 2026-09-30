// Unit tests: analytics vs hand-computed values (tests/EXPECTED.md), parser vs real txs.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as S from "../js/stats.js";
import { parseTx } from "../js/parse-tx.js";
import { validateDoc, validateTrade } from "../js/schema.js";

const read = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok -", name); };

const A = read("mock-a.json");
const NOW = Date.parse("2026-10-07T13:00:00+10:00");
const mint = (k) => (k + "mint").padEnd(44, "1");
const gt = read("ohlcv-ddd.json").data.attributes.ohlcv_list.map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c })).sort((a, b) => a.t - b.t);
const candles = { [mint("DDD")]: gt };
const marks = { [mint("DDD")]: { price_sol: 0.0015, chain_qty: 100 } };

const { positions, rowInfo } = S.buildPositions(A.trades);
S.markPositions(positions, marks, NOW);
for (const p of positions) p.ex = S.excursion(candles[p.mint], p.open_time, p.closed ? p.close_time : NOW, p.entry_price);
const P = Object.fromEntries(positions.map((p) => [p.token, p]));

test("positions and realized P&L (average cost)", () => {
  assert.equal(positions.length, 4);
  near(P.AAA.realized, 0.1); near(P.BBB.realized, -0.04); near(P.CCC.realized, 0.03);
  near(P.AAA.pnl_pct, 50); near(P.BBB.pnl_pct, -40); near(P.CCC.pnl_pct, 15);
  assert.equal(P.DDD.closed, false);
  near(P.DDD.remaining_cost, 0.1); near(P.DDD.value, 0.15); near(P.DDD.x, 1.5); near(P.DDD.unrealized, 0.05);
  near(rowInfo.get("sccc1").realized, 0.05); near(rowInfo.get("sccc2").realized, -0.02);
  near(P.BBB.hold_ms / 3600e3, 27);
});
test("MFE / MAE from candles", () => {
  near(P.DDD.ex.mfe_pct, 60, 1e-6); near(P.DDD.ex.mae_pct, -30, 1e-6);
  assert.equal(P.AAA.ex, null);
});
const eq = S.equityCurve(A.trades, positions, candles, { [mint("DDD")]: 0.0015 }, NOW);
test("equity curve, drawdown", () => {
  const last = eq.points[eq.points.length - 1];
  near(last.equity, 1.64); near(last.deposits, 1.5); near(last.pnl, 0.14); near(last.realized, 0.09); near(last.fees, 0.011);
  near(eq.max_dd, -0.04); near(eq.max_dd_pct, (-0.04 / 1.1) * 100, 1e-9);
  assert.equal(eq.approx, true);
});
const agg = S.aggregates(positions, A.trades, { netPnl: 0.14 });
test("aggregates", () => {
  assert.equal(agg.n_closed, 3); assert.equal(agg.wins, 2); assert.equal(agg.losses, 1);
  near(agg.win_rate, 200 / 3); near(agg.avg_win_sol, 0.065); near(agg.avg_win_pct, 32.5); near(agg.avg_loss_sol, -0.04); near(agg.avg_loss_pct, -40);
  near(agg.profit_factor, 3.25); near(agg.expectancy_sol, 0.03); near(agg.expectancy_pct, 25 / 3); near(agg.avg_r, 25 / 35 / 3);
  assert.deepEqual(agg.streaks, { current: { kind: "win", n: 1 }, longest_win: 1, longest_loss: 1 });
  near(agg.max_dd_closed.dd, -0.04); near(agg.fees_sol, 0.011); near(agg.fees_pct_of_pnl, (0.011 / 0.14) * 100);
  assert.equal(agg.too_few, true);
});
test("streaks helper", () => {
  assert.deepEqual(S.streaks([1, 1, -1, -1, -1, 1]), { current: { kind: "win", n: 1 }, longest_win: 2, longest_loss: 3 });
});
test("breakdowns", () => {
  const run = Object.fromEntries(S.breakdown(positions, "run").map((r) => [r.key, r]));
  assert.equal(run.test.n, 2); near(run.test.win_rate, 50); near(run.test.total, 0.06); near(run.test.roi_pct, 20);
  assert.equal(run.real.n, 2); assert.equal(run.real.closed, 1); near(run.real.win_rate, 100); near(run.real.total, 0.08); near(run.real.roi_pct, (0.08 / 0.3) * 100);
  assert.deepEqual(S.breakdown(positions, "hour").map((r) => r.key), ["09:00", "10:00", "11:00", "20:00"]);
  assert.deepEqual(S.breakdown(positions, "dow").map((r) => [r.key, r.n]), [["Mon", 1], ["Tue", 1], ["Wed", 2]]);
  assert.deepEqual(S.breakdown(positions, "hold").map((r) => [r.key, r.n]), [["1-6 h", 3], ["1-3 d", 1]]);
  assert.deepEqual(S.breakdown(positions, "liquidity").map((r) => [r.key, r.n]), [["< $50k", 1], ["$100k-250k", 2], ["unknown", 1]]);
  assert.deepEqual(S.breakdown(positions, "age").map((r) => [r.key, r.n]), [["< 12 h", 1], ["12 h-3 d", 2], ["unknown", 1]]);
});
test("daily P&L", () => {
  const d = Object.fromEntries(S.dailyPnl(eq.points).map((x) => [x.day, x.pnl]));
  near(d["2026-09-28"], 0.1); near(d["2026-09-30"], -0.04); near(d["2026-10-07"], 0.08);
});
test("rule adherence", () => {
  const ea = S.entryAdherence(A.trades.filter((t) => t.action === "BUY"));
  assert.equal(ea.n, 4); assert.equal(ea.passed_all, 2); assert.equal(ea.failed_any, 1); assert.equal(ea.incomplete, 1); near(ea.passed_all_pct, 50);
  const kinds = (p) => S.exitAdherence(p, p.ex, NOW).map((x) => x.kind);
  assert.deepEqual(kinds(P.AAA), []); assert.deepEqual(kinds(P.BBB), ["late"]); assert.deepEqual(kinds(P.CCC), []); assert.deepEqual(kinds(P.DDD), ["late", "missed"]);
  const b = A.trades.find((t) => t.id === "bddd");
  const sim = S.simulateLot({ entry: S.tradeCost(b) / b.tokens, cost: S.tradeCost(b), fromMs: S.ms(b.time_aest), candles: gt, now: NOW, lastPrice: 0.0015 });
  near(sim.proceeds, 0.1 / 3 * 1.5 * 0.99); near(sim.openValue, 0.1); near(sim.pnl, 0.0495); assert.equal(sim.events[0].why, "target_1.5x");
  // stop path
  const stop = S.simulateLot({ entry: 1, cost: 1, fromMs: 0, candles: [{ t: 0, o: 1, h: 1.1, l: 0.6, c: 0.7 }], lastPrice: 0.7 });
  near(stop.pnl, 0.65 * 0.99 - 1); assert.equal(stop.events[0].why, "stop");
  // trail path: 1.5x, 2x, peak 3x, then -25%
  const tr = S.simulateLot({ entry: 1, cost: 1, fromMs: 0, candles: [{ t: 0, o: 1, h: 2.1, l: 1, c: 2 }, { t: 1, o: 2, h: 3, l: 2.5, c: 3 }, { t: 2, o: 3, h: 3, l: 2, c: 2 }], friction: 0 });
  near(tr.proceeds, 1.5 / 3 + 2 / 3 + 2.25 / 3); assert.deepEqual(tr.events.map((e) => e.why), ["target_1.5x", "target_2x", "trail"]);
  // time stop: 7 h flat
  const ts = S.simulateLot({ entry: 1, cost: 1, fromMs: 0, candles: Array.from({ length: 8 }, (_, i) => ({ t: i * 3600e3, o: 1, h: 1.1, l: 0.9, c: 1 })), friction: 0 });
  assert.equal(ts.events[0].why, "time_stop"); near(ts.pnl, 0);
});
test("next-action hints", () => {
  assert.match(S.nextAction(P.DDD, P.DDD.ex, NOW).text, /1\.5x reached/);
  assert.equal(S.nextAction(P.DDD, P.DDD.ex, NOW).level, "amber");
});
test("rule panel (real) scenario A", () => {
  const r = S.rulePanel(A.trades, positions, NOW, { scope: "real" });
  assert.equal(r.buys.n, 2); assert.equal(r.buys.level, "amber");
  assert.equal(r.streak.n, 0); assert.equal(r.streak.level, "green");
  near(r.weekly.topup, 0.5); near(r.weekly.pnl, 0.08); near(r.weekly.pct, 16); assert.equal(r.weekly.level, "green");
  const t = S.rulePanel(A.trades, positions, NOW, { scope: "test" });
  assert.equal(t.buys.n, 0); assert.equal(t.streak.n, 1); assert.equal(t.streak.level, "amber"); assert.equal(t.weekly.level, "grey");
});
test("rule panel scenario B (all red)", () => {
  const B = read("mock-b.json");
  const now = Date.parse("2026-10-08T15:00:00+10:00");
  const { positions: pb } = S.buildPositions(B.trades);
  S.markPositions(pb, { [mint("GGG")]: { price_sol: 0.0003 } }, now);
  const r = S.rulePanel(B.trades, pb, now, { scope: "real" });
  assert.equal(r.buys.n, 3); assert.equal(r.buys.level, "red");
  assert.equal(r.streak.n, 2); assert.equal(r.streak.level, "red"); assert.equal(r.streak.pause_until, Date.parse("2026-10-09T13:00:00+10:00"));
  near(r.weekly.pnl, -0.109); near(r.weekly.pct, -54.5); assert.equal(r.weekly.level, "red");
  const g = pb.find((p) => p.token === "GGG");
  assert.equal(S.nextAction(g, null, now).level, "red");
});
test("parser vs real chain txs", () => {
  const W = "CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f";
  const si = parseTx(read("tx-si-buy.json").result, W);
  assert.equal(si.action, "BUY"); assert.equal(si.mint, "7Wh6rxVWUBFCNCWCz7nLaV7z3SDr2M6rFTjjWP6aE8p1"); assert.equal(si.tokens, 85212.77177);
  assert.equal(si.sol, 0.101599841); assert.equal(si.rent_sol, 0.00151384); assert.equal(si.swap_sol, 0.1); assert.equal(si.fee_sol, 0.000936001);
  const sell = parseTx(read("tx-inuink-sell.json").result, W);
  assert.equal(sell.action, "SELL"); assert.equal(sell.sol, 0.020480229); assert.equal(sell.tokens, 2862.577154);
  const dep = parseTx(read("tx-deposit.json").result, W);
  assert.equal(dep.action, "DEPOSIT"); assert.equal(dep.sol, 0.075347871); assert.equal(dep.fee_sol, 0);
});
test("schema validation", () => {
  assert.deepEqual(validateDoc(A), []);
  const bad = { ...A.trades[1], entry_snapshot: { ...A.trades[1].entry_snapshot, filters_passed: ["nope"] } };
  assert.ok(validateTrade(bad).some((e) => /unknown filter/.test(e)));
  const noSnap = { ...A.trades[1] }; delete noSnap.entry_snapshot.liquidity_usd;
  assert.ok(validateTrade(noSnap).some((e) => /liquidity_usd is required/.test(e)));
  assert.ok(validateTrade({ ...A.trades[2], exit_reason: "yolo" }).some((e) => /exit_reason/.test(e)));
  assert.ok(validateTrade({ ...A.trades[0], time_aest: "2026-09-28T10:00:00Z" }).some((e) => /time_aest/.test(e)));
});
console.log(`\n${n} unit test groups passed`);
