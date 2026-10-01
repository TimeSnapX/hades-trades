// Hades Trades analytics. Pure functions (no DOM, no network) so they can be
// unit-tested in Node against hand-computed values.
//
// Conventions (see docs/SCHEMA.md):
// - cost of a BUY  = sol - rent_sol   (SOL that left the wallet for the trade, incl. fees; rent is recoverable)
// - proceeds of a SELL = sol + rent_sol (rent_sol <= 0 when a token account is closed and refunded)
// - positions use average cost; a position closes when its token quantity returns to ~0.
// - prices/candles are SOL per token.

export const H = 3600e3;
export const REAL_RULES = {
  rule_set: "real-run-v1",
  take_profit: [{ x: 1.5, sell_frac: 1 / 3 }, { x: 2, sell_frac: 1 / 3 }],
  trail_pct: 25,
  stop_x: 0.65,
  time_stop_hours: 6,
  time_stop_min_x: 1.2,
  keep_min_frac: 0,
  max_buys_per_day: 2,
  pause_after_losses: 2,
  pause_hours: 24,
  weekly_stop_pct: -50,
};
export const STOP_PCT = 35; // R = pnl% / 35%
export const MIN_SAMPLE = 20;

export const ms = (iso) => Date.parse(iso);
const aest = (t) => new Date(t + 10 * H);
export const aestHour = (t) => aest(t).getUTCHours();
export const aestDow = (t) => (aest(t).getUTCDay() + 6) % 7; // 0 = Monday
export const aestDay = (t) => aest(t).toISOString().slice(0, 10);
export const aestDayStart = (t) => { const d = aest(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 10 * H; };
export const aestWeekStart = (t) => aestDayStart(t) - aestDow(t) * 24 * H;
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const sum = (a) => a.reduce((s, x) => s + x, 0);
const EPS_QTY = 1e-9;

export const tradeCost = (t) => t.sol - (t.rent_sol || 0);
export const tradeProceeds = (t) => t.sol + (t.rent_sol || 0);
// Change of the wallet's native SOL balance. A SELL whose proceeds were paid to
// another account (proceeds_external) records the real change in wallet_sol_delta.
export function solDelta(t) {
  if (typeof t.wallet_sol_delta === "number") return t.wallet_sol_delta;
  if (t.action === "DEPOSIT" || t.action === "SELL") return t.sol;
  return -t.sol;
}
// Net money the user put in (+) or took out (-). External sell proceeds count as
// a withdrawal of their value (they left the wallet straight away).
export function depositDelta(t) {
  if (t.action === "DEPOSIT") return t.sol;
  if (t.action === "WITHDRAW") return -t.sol;
  if (t.action === "SELL" && t.proceeds_external) return -(t.proceeds_external.sol_equiv || 0);
  return 0;
}
export function depositDeltaUsd(t) {
  if (t.action === "DEPOSIT") return t.usd_at_time;
  if (t.action === "WITHDRAW") return t.usd_at_time == null ? null : -t.usd_at_time;
  if (t.action === "SELL" && t.proceeds_external) return t.proceeds_external.usd_equiv == null ? null : -t.proceeds_external.usd_equiv;
  return 0;
}

export function inScope(t, scope) { return !scope || scope === "all" || t.run === scope; }

// ---- Me vs Agent ----------------------------------------------------------
export const GROUPS = ["human", "agent"];
export const GROUP_LABEL = { human: "Me", agent: "Agent", all: "All" };
// overrides: {tx: "human"|"agent"} (local, from the app's localStorage).
export function traderOf(t, overrides) {
  const o = overrides && overrides[t.tx];
  if (o === "human" || o === "agent") return o;
  if (t.trader === "human" || t.trader === "agent") return t.trader;
  return t.action === "DEPOSIT" || t.action === "WITHDRAW" ? "human" : "agent";
}
export function traderSourceOf(t, overrides) {
  const o = overrides && overrides[t.tx];
  if ((o === "human" || o === "agent") && o !== (t.trader || null)) return "manual_override";
  if (t.trader_source) return t.trader_source;
  if (t.trader) return "logged";
  return t.action === "DEPOSIT" || t.action === "WITHDRAW" ? "inferred" : "logged";
}
// Copies of the rows with the effective group in `_trader` / `_tsrc`.
export function annotate(trades, overrides) {
  return trades.map((t) => ({ ...t, _trader: traderOf(t, overrides), _tsrc: traderSourceOf(t, overrides) }));
}
const groupOf = (t) => t._trader || traderOf(t);
export function inGroup(x, g) { return !g || g === "all" || (x._trader ? x._trader : x.trader ? x.trader : groupOf(x)) === g; }

// ---- positions ------------------------------------------------------------
// One position per (mint, group, episode). Lots are matched FIFO within the
// group; a sell with no (or not enough) inventory in its own group takes the
// other group's inventory and that leg is flagged `crossed`.
export class Ledger {
  constructor() { this.open = new Map(); this.all = []; this.rowInfo = new Map(); }
  _new(t, g) {
    const p = { key: `${t.mint}:${g}:${this.all.length}`, mint: t.mint, token: t.token, trader: g, run: t.run, open_time: ms(t.time_aest), close_time: null, buys: [], sells: [], lots: [], qty: 0, bought_qty: 0, cost_in: 0, remaining_cost: 0, proceeds: 0, realized: 0, fees: 0, closed: false, crossed: false, crossed_sells: [] };
    this.open.set(`${t.mint}|${g}`, p); this.all.push(p);
    return p;
  }
  apply(t) {
    if (t.action !== "BUY" && t.action !== "SELL") return null;
    const g = groupOf(t);
    if (t.action === "BUY") {
      const p = this.open.get(`${t.mint}|${g}`) || this._new(t, g);
      const c = tradeCost(t);
      p.buys.push(t);
      p.lots.push({ qty: t.tokens, cost: c, qty0: t.tokens });
      p.qty += t.tokens; p.bought_qty += t.tokens; p.cost_in += c; p.remaining_cost += c; p.fees += t.fee_sol || 0;
      const info = { position: p, legs: [], group: g };
      this.rowInfo.set(t.id, info);
      return info;
    }
    const other = g === "human" ? "agent" : "human";
    const legs = [];
    let need = t.tokens;
    for (const [grp, crossed] of [[g, false], [other, true]]) {
      const p = this.open.get(`${t.mint}|${grp}`);
      if (!p || need <= 0) continue;
      let q = 0, c = 0;
      while (need > 0 && p.lots.length) {
        const lot = p.lots[0];
        const take = Math.min(need, lot.qty);
        const co = lot.qty > 0 ? lot.cost * (take / lot.qty) : 0;
        lot.qty -= take; lot.cost -= co; need -= take; q += take; c += co;
        if (lot.qty <= Math.max(EPS_QTY, lot.qty0 * 1e-9)) { c += lot.cost; q += lot.qty; need -= Math.min(need, lot.qty); p.lots.shift(); }
      }
      if (need > 0 && need <= Math.max(EPS_QTY, t.tokens * 1e-9)) need = 0; // rounding dust
      if (q > 0) legs.push({ position: p, qty: q, cost_out: c, crossed, seller: g });
    }
    if (!legs.length) { const info = { position: null, orphan: true, legs: [], group: g }; this.rowInfo.set(t.id, info); return info; }
    const proceeds = tradeProceeds(t);
    const qsum = legs.reduce((s, l) => s + l.qty, 0);
    for (const l of legs) {
      const p = l.position, share = qsum ? l.qty / qsum : 1;
      l.proceeds = proceeds * share; l.realized = l.proceeds - l.cost_out; l.time = ms(t.time_aest); l.trade = t;
      if (!p.sells.includes(t)) p.sells.push(t);
      p.remaining_cost -= l.cost_out; p.qty -= l.qty; p.proceeds += l.proceeds; p.realized += l.realized; p.fees += (t.fee_sol || 0) * share;
      if (l.crossed) { p.crossed = true; p.crossed_sells.push({ trade: t, qty: l.qty, realized: l.realized, seller: g }); }
      if (!p.lots.length || p.qty <= Math.max(EPS_QTY, p.bought_qty * 1e-9)) {
        p.qty = 0; p.remaining_cost = 0; p.lots = []; p.closed = true; p.close_time = ms(t.time_aest);
        this.open.delete(`${t.mint}|${p.trader}`);
      }
    }
    const costOut = legs.reduce((s, l) => s + l.cost_out, 0), realized = proceeds - costOut;
    const info = { position: legs[0].position, legs, group: g, crossed: legs.some((l) => l.crossed), realized, cost_out: costOut, pnl_pct: costOut ? (realized / costOut) * 100 : null, exit_x: costOut ? proceeds / costOut : null };
    this.rowInfo.set(t.id, info);
    return info;
  }
}

export function buildPositions(trades) {
  const L = new Ledger();
  for (const t of trades) L.apply(t);
  for (const p of L.all) {
    p.entry_price = p.bought_qty ? p.cost_in / p.bought_qty : null; // SOL per token incl. fees
    p.sold_frac = p.bought_qty ? Math.min(1, (p.bought_qty - p.qty) / p.bought_qty) : 0;
    if (p.closed) p.sold_frac = 1;
    const lastBuy = p.buys[p.buys.length - 1];
    p.planned_targets = lastBuy.planned_targets || (p.run === "real" && p.trader === "agent" ? REAL_RULES : null);
    const snap = p.buys[0].entry_snapshot || {};
    p.snapshot = snap;
  }
  return { positions: L.all, rowInfo: L.rowInfo };
}

// Mark open positions with live data. marks: mint -> {price_sol, chain_qty?}
export function markPositions(positions, marks, now) {
  for (const p of positions) {
    const m = marks && marks[p.mint];
    p.hold_ms = (p.closed ? p.close_time : now) - p.open_time;
    if (p.closed) { p.value = 0; p.unrealized = 0; p.total_pnl = p.realized; p.pnl_pct = p.cost_in ? (p.realized / p.cost_in) * 100 : null; p.x = p.cost_in ? p.proceeds / p.cost_in : null; continue; }
    const qty = m && m.chain_qty != null ? m.chain_qty : p.qty;
    p.chain_qty = m && m.chain_qty != null ? m.chain_qty : null;
    p.qty_mismatch = p.chain_qty != null && Math.abs(p.chain_qty - p.qty) > Math.max(1e-6, p.qty * 1e-6);
    p.price_now = m && m.price_sol != null ? m.price_sol : null;
    p.value = p.price_now != null ? qty * p.price_now : null;
    p.unrealized = p.value != null ? p.value - p.remaining_cost : null;
    p.total_pnl = p.unrealized != null ? p.realized + p.unrealized : null;
    p.pnl_pct = p.total_pnl != null && p.cost_in ? (p.total_pnl / p.cost_in) * 100 : null;
    // x-multiple of the remaining holding vs its remaining cost basis
    p.x = p.value != null && p.remaining_cost > 0 ? p.value / p.remaining_cost : null;
  }
  return positions;
}

// ---- candles --------------------------------------------------------------
// candles: [{t (ms), o, h, l, c}] ascending, SOL per token.
export function excursion(candles, fromMs, toMs, entry) {
  if (!candles || !candles.length || !entry) return null;
  const w = candles.filter((c) => c.t + 1 >= fromMs - 5 * 60e3 && c.t <= toMs);
  const within = w.filter((c) => c.t >= fromMs - 5 * 60e3);
  if (!within.length) return null;
  const hi = Math.max(...within.map((c) => c.h));
  const lo = Math.min(...within.map((c) => c.l));
  const coverStart = within[0].t, coverEnd = within[within.length - 1].t;
  return { mfe_pct: (hi / entry - 1) * 100, mae_pct: (lo / entry - 1) * 100, peak: hi, trough: lo, partial: coverStart > fromMs + 15 * 60e3 };
}

export function priceAt(candles, t) {
  if (!candles || !candles.length) return null;
  let lo = 0, hi = candles.length - 1, ans = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (candles[mid].t <= t) { ans = candles[mid].c; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

// Simulate the real-run exit rules on one lot. Conservative: within a candle
// the stop is checked before targets. Returns {proceeds, exit, events, open}.
export function simulateLot({ entry, cost, fromMs, candles, now, rules = REAL_RULES, lastPrice = null, friction = 0.01 }) {
  if (!candles || !candles.length || !entry) return null;
  const after = candles.filter((c) => c.t >= fromMs - 60e3);
  if (!after.length) return null;
  let frac = 1, proceeds = 0, peak = 0, tp = 0, maxX = 0;
  const events = [];
  const sell = (f, price, why, t) => { const amt = Math.min(frac, f); if (amt <= 0) return; proceeds += cost * amt * (price / entry) * (1 - friction); frac -= amt; events.push({ why, t, x: price / entry, frac: amt }); };
  for (const c of after) {
    const xl = c.l / entry, xh = c.h / entry;
    if (xl <= rules.stop_x) { sell(frac, entry * rules.stop_x, "stop", c.t); break; }
    if (tp >= 2 && peak && c.l <= peak * (1 - rules.trail_pct / 100)) { sell(frac, peak * (1 - rules.trail_pct / 100), "trail", c.t); break; }
    maxX = Math.max(maxX, xh);
    if (tp === 0 && xh >= rules.take_profit[0].x) { sell(rules.take_profit[0].sell_frac, entry * rules.take_profit[0].x, "target_1.5x", c.t); tp = 1; }
    if (tp === 1 && xh >= rules.take_profit[1].x) { sell(rules.take_profit[1].sell_frac, entry * rules.take_profit[1].x, "target_2x", c.t); tp = 2; peak = c.h; }
    if (tp >= 2) peak = Math.max(peak, c.h);
    if (c.t - fromMs >= rules.time_stop_hours * H && maxX < rules.time_stop_min_x && frac > 0) { sell(frac, c.c, "time_stop", c.t); break; }
    if (frac <= 1e-12) break;
  }
  const mark = lastPrice != null ? lastPrice : after[after.length - 1].c;
  const openValue = frac > 1e-12 ? cost * frac * (mark / entry) : 0;
  return { proceeds, openValue, total: proceeds + openValue, pnl: proceeds + openValue - cost, open: frac > 1e-12, events };
}

// ---- price-history sanity ------------------------------------------------
// GeckoTerminal candles are only trustworthy for P&L when they are SOL per token.
// A pool quoted in another asset (e.g. DARK/wNEAR) returns "token" prices in that
// asset, which can be off by a constant factor (DARK: ~26x). Two guards:
// 1. unit check: the series' median ratio to the logged fills (and the live price)
//    must be within UNIT_MISMATCH_X, else the whole series is rejected;
// 2. point bounds: candles above max known price x PRICE_BOUND_X (fake peaks
//    make fake drawdowns), or non-positive/non-finite, are dropped. There is no
//    lower bound: real rugs go to ~0, and a too-low mark can only lose what the
//    lot cost, which the drawdown guard in pnlCurve caps.
// Rejected/missing history means the position is held at cost between trades
// (realized-only for that token), with a note in the UI.
export const UNIT_MISMATCH_X = 3;
export const PRICE_BOUND_X = 50;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function candleNear(cs, t, win) {
  let lo = 0, hi = cs.length - 1, ans = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid].t <= t) { ans = cs[mid]; lo = mid + 1; } else hi = mid - 1; }
  return ans && t - ans.t <= win ? ans : null;
}
export const fillPrice = (t) => (t.price_filled > 0 ? t.price_filled : t.tokens > 0 ? t.sol / t.tokens : null);
export function sanitizeCandles(trades, candlesByMint, livePrices, now) {
  const clean = {}, rejected = {}, dropped = {};
  for (const [mint, cs] of Object.entries(candlesByMint || {})) {
    if (!Array.isArray(cs) || !cs.length) continue;
    const fills = trades.filter((t) => t.mint === mint && (t.action === "BUY" || t.action === "SELL") && t.tokens > 0)
      .map((t) => ({ t: ms(t.time_aest), px: fillPrice(t), token: t.token })).filter((f) => f.px > 0);
    const live = livePrices && livePrices[mint] > 0 ? livePrices[mint] : null;
    const anchors = fills.map((f) => f.px).concat(live ? [live] : []);
    const token = fills.length ? fills[0].token : mint.slice(0, 6);
    if (!anchors.length) { rejected[mint] = { token, reason: "no fill or live price to check it against" }; continue; }
    const ratios = [];
    for (const f of fills) { const c = candleNear(cs, f.t, 30 * 60e3); if (c && c.c > 0) ratios.push(c.c / f.px); }
    if (live && now != null) { const c = cs[cs.length - 1]; if (c.c > 0 && now - c.t <= 60 * 60e3) ratios.push(c.c / live); }
    if (ratios.length) {
      const r = median(ratios);
      if (!(r <= UNIT_MISMATCH_X && r >= 1 / UNIT_MISMATCH_X)) { rejected[mint] = { token, reason: `history is ${r >= 1 ? r.toFixed(1) + "x" : "1/" + (1 / r).toFixed(1) + "x"} the traded prices (pool not quoted in SOL?)`, ratio: r }; continue; }
    }
    const hi = Math.max(...anchors) * PRICE_BOUND_X;
    const ok = (v) => Number.isFinite(v) && v > 0 && v <= hi;
    const keep = cs.filter((c) => ok(c.o) && ok(c.h) && ok(c.l) && ok(c.c));
    if (keep.length < cs.length) dropped[mint] = cs.length - keep.length;
    if (keep.length) clean[mint] = keep; else rejected[mint] = { token, reason: "every candle was outside the plausible price range" };
  }
  return { clean, rejected, dropped };
}

// ---- aggregates -----------------------------------------------------------
export function streaks(outcomes) { // outcomes: array of +1 / -1 in time order
  let longestW = 0, longestL = 0, run = 0, sign = 0;
  for (const o of outcomes) {
    if (o === sign) run++; else { sign = o; run = 1; }
    if (sign > 0) longestW = Math.max(longestW, run); else longestL = Math.max(longestL, run);
  }
  return { current: outcomes.length ? { kind: sign > 0 ? "win" : "loss", n: run } : null, longest_win: longestW, longest_loss: longestL };
}

export function maxDrawdown(series) { // series: [{t, v}] P&L (SOL); returns worst peak-to-trough
  let peak = -Infinity, peakT = null, worst = 0, at = null, from = null;
  for (const p of series) {
    if (p.v > peak) { peak = p.v; peakT = p.t; }
    const dd = p.v - peak;
    if (dd < worst) { worst = dd; at = p.t; from = peakT; }
  }
  return { dd: worst, from, to: at };
}

export function aggregates(positions, trades, { netPnl = null } = {}) {
  const closed = positions.filter((p) => p.closed).sort((a, b) => a.close_time - b.close_time);
  const wins = closed.filter((p) => p.realized > 0);
  const losses = closed.filter((p) => p.realized <= 0);
  const n = closed.length;
  const sw = sum(wins.map((p) => p.realized)), sl = sum(losses.map((p) => p.realized));
  const pct = (p) => (p.realized / p.cost_in) * 100;
  const fees = sum(trades.filter((t) => t.action === "BUY" || t.action === "SELL").map((t) => t.fee_sol || 0));
  const closedSeries = [{ t: 0, v: 0 }];
  let cum = 0;
  for (const p of closed) { cum += p.realized; closedSeries.push({ t: p.close_time, v: cum }); }
  return {
    n_closed: n,
    n_open: positions.length - n,
    n_positions: positions.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: n ? (wins.length / n) * 100 : null,
    avg_win_sol: wins.length ? sw / wins.length : null,
    avg_win_pct: wins.length ? sum(wins.map(pct)) / wins.length : null,
    avg_loss_sol: losses.length ? sl / losses.length : null,
    avg_loss_pct: losses.length ? sum(losses.map(pct)) / losses.length : null,
    profit_factor: n ? (sl < 0 ? sw / -sl : sw > 0 ? Infinity : null) : null,
    expectancy_sol: n ? (sw + sl) / n : null,
    expectancy_pct: n ? sum(closed.map(pct)) / n : null,
    realized_sol: sw + sl,
    avg_r: n ? sum(closed.map((p) => pct(p) / STOP_PCT)) / n : null,
    streaks: streaks(closed.map((p) => (p.realized > 0 ? 1 : -1))),
    max_dd_closed: maxDrawdown(closedSeries),
    fees_sol: fees,
    fees_pct_of_pnl: netPnl ? (fees / Math.abs(netPnl)) * 100 : null,
    too_few: n < MIN_SAMPLE,
  };
}

// ---- breakdowns -----------------------------------------------------------
export const BUCKETS = {
  hold: [["< 1 h", 0, 1], ["1-6 h", 1, 6], ["6-24 h", 6, 24], ["1-3 d", 24, 72], ["> 3 d", 72, Infinity]],
  liquidity: [["< $50k", 0, 5e4], ["$50k-100k", 5e4, 1e5], ["$100k-250k", 1e5, 2.5e5], ["> $250k", 2.5e5, Infinity]],
  age: [["< 12 h", 0, 12], ["12 h-3 d", 12, 72], ["3-14 d", 72, 336], ["> 14 d", 336, Infinity]],
};
function bucketOf(list, v) {
  if (v == null) return "unknown";
  const b = list.find(([, lo, hi]) => v >= lo && v < hi);
  return b ? b[0] : "unknown";
}
export function groupKey(p, by) {
  switch (by) {
    case "token": return p.token;
    case "hour": return String(aestHour(p.open_time)).padStart(2, "0") + ":00";
    case "dow": return DOW[aestDow(p.open_time)];
    case "hold": return bucketOf(BUCKETS.hold, p.hold_ms / H);
    case "liquidity": return bucketOf(BUCKETS.liquidity, p.snapshot.liquidity_usd);
    case "age": return bucketOf(BUCKETS.age, p.snapshot.age_hours);
    case "run": return p.run;
    case "trader": return GROUP_LABEL[p.trader] || p.trader;
    default: return "?";
  }
}
export function breakdown(positions, by) {
  const g = new Map();
  for (const p of positions) {
    const k = groupKey(p, by);
    const r = g.get(k) || { key: k, n: 0, closed: 0, wins: 0, realized: 0, unrealized: 0, unknown_value: 0, cost: 0, pcts: [] };
    r.n++; r.cost += p.cost_in; r.realized += p.realized;
    if (p.closed) { r.closed++; if (p.realized > 0) r.wins++; }
    else if (p.unrealized != null) r.unrealized += p.unrealized; else r.unknown_value++;
    if (p.pnl_pct != null) r.pcts.push(p.pnl_pct);
    g.set(k, r);
  }
  const order = { hold: BUCKETS.hold.map((b) => b[0]), liquidity: BUCKETS.liquidity.map((b) => b[0]), age: BUCKETS.age.map((b) => b[0]), dow: DOW };
  const rows = [...g.values()].map((r) => ({ ...r, total: r.realized + r.unrealized, win_rate: r.closed ? (r.wins / r.closed) * 100 : null, avg_pct: r.pcts.length ? sum(r.pcts) / r.pcts.length : null, roi_pct: r.cost ? ((r.realized + r.unrealized) / r.cost) * 100 : null }));
  const ord = order[by];
  rows.sort((a, b) => (ord ? (ord.indexOf(a.key) + 1 || 99) - (ord.indexOf(b.key) + 1 || 99) : a.key < b.key ? -1 : 1));
  return rows;
}

// ---- equity curve ---------------------------------------------------------
// candlesByMint: mint -> candles; livePrices: mint -> price_sol (for the final point).
export function equityCurve(trades, positionsAll, candlesByMint, livePrices, now, { maxPoints = 400 } = {}) {
  const tx = trades.filter((t) => t.action);
  if (!tx.length) return { points: [], approx: true };
  const t0 = ms(tx[0].time_aest);
  const span = Math.max(now - t0, 60e3);
  const step = Math.max(5 * 60e3, Math.ceil(span / maxPoints / 60e3) * 60e3);
  const times = new Set();
  for (let t = t0; t < now; t += step) times.add(t);
  for (const t of tx) times.add(ms(t.time_aest));
  times.add(now);
  const grid = [...times].sort((a, b) => a - b);
  const events = tx.map((t) => ({ t: ms(t.time_aest), r: t })).sort((a, b) => a.t - b.t);
  const realizedByTrade = new Map();
  const { rowInfo } = buildPositions(tx);
  for (const t of tx) { const i = rowInfo.get(t.id); if (i && i.realized != null) realizedByTrade.set(t.id, i.realized); }
  let ei = 0, sol = 0, rent = 0, dep = 0, realized = 0, fees = 0;
  const qty = new Map(), cost = new Map();
  let approx = false;
  const points = [];
  for (const t of grid) {
    while (ei < events.length && events[ei].t <= t) {
      const r = events[ei].r;
      sol += solDelta(r);
      rent += r.rent_sol || 0;
      dep += depositDelta(r);
      if (r.action === "BUY" || r.action === "SELL") fees += r.fee_sol || 0;
      if (r.action === "BUY") { qty.set(r.mint, (qty.get(r.mint) || 0) + r.tokens); cost.set(r.mint, (cost.get(r.mint) || 0) + tradeCost(r)); }
      if (r.action === "SELL") {
        const q = qty.get(r.mint) || 0; const f = q ? Math.min(1, r.tokens / q) : 0;
        cost.set(r.mint, (cost.get(r.mint) || 0) * (1 - f)); qty.set(r.mint, Math.max(0, q - r.tokens));
        realized += realizedByTrade.get(r.id) || 0;
      }
      ei++;
    }
    let tokensValue = 0, ptApprox = false;
    for (const [mint, q] of qty) {
      if (q <= 0) continue;
      let px = t >= now && livePrices && livePrices[mint] != null ? livePrices[mint] : priceAt(candlesByMint && candlesByMint[mint], t);
      if (px == null) { px = (cost.get(mint) || 0) / q; ptApprox = true; }
      tokensValue += q * px;
    }
    if (ptApprox) approx = true;
    const equity = sol + rent + tokensValue;
    points.push({ t, equity, deposits: dep, pnl: equity - dep, realized, fees, approx: ptApprox });
  }
  // drawdown under the P&L curve
  let peak = -Infinity, peakEq = 0;
  for (const p of points) {
    if (p.pnl > peak) { peak = p.pnl; peakEq = p.equity; }
    p.dd = p.pnl - peak;
    p.dd_pct = peakEq > 0 ? (p.dd / peakEq) * 100 : 0;
  }
  const worst = points.reduce((w, p) => (p.dd < w.dd ? p : w), { dd: 0, dd_pct: 0 });
  return { points, approx, max_dd: worst.dd, max_dd_pct: worst.dd_pct };
}

// P&L curve of one group (Me or Agent), built from its positions: realized legs
// plus open lots marked to market (candles, live price at `now`, else at cost ->
// approx). Same point shape as equityCurve (no deposits: a group has no bank).
export function pnlCurve(trades, group, candlesByMint, livePrices, now, { maxPoints = 400 } = {}) {
  const tx = trades.filter((t) => t.action === "BUY" || t.action === "SELL");
  const mine = (t) => groupOf(t) === group;
  if (!tx.length) return { points: [], approx: false, max_dd: 0, max_dd_pct: null };
  const t0 = ms(tx[0].time_aest);
  const span = Math.max(now - t0, 60e3);
  const step = Math.max(5 * 60e3, Math.ceil(span / maxPoints / 60e3) * 60e3);
  const times = new Set();
  for (let t = t0; t < now; t += step) times.add(t);
  for (const t of tx) times.add(ms(t.time_aest));
  times.add(now);
  const grid = [...times].sort((a, b) => a - b);
  // Only this group's own legs: realized P&L of its positions plus its open lots
  // marked to market. No deposits, no wallet balance, no cost totals.
  const L = new Ledger();
  let ei = 0, realized = 0, fees = 0, approx = false, deployed = 0;
  const atCost = new Set();
  const points = [];
  for (const t of grid) {
    while (ei < tx.length && ms(tx[ei].time_aest) <= t) {
      const r = tx[ei];
      const info = L.apply(r);
      if (mine(r)) fees += r.fee_sol || 0;
      if (r.action === "BUY" && info && info.position && info.position.trader === group) deployed += tradeCost(r);
      if (info) for (const l of info.legs) if (l.position.trader === group) realized += l.realized;
      ei++;
    }
    let unreal = 0, ptApprox = false;
    for (const p of L.open.values()) {
      if (p.trader !== group || p.qty <= 0) continue;
      let px = t >= now && livePrices && livePrices[p.mint] != null ? livePrices[p.mint] : priceAt(candlesByMint && candlesByMint[p.mint], t);
      if (px == null) { px = p.remaining_cost / p.qty; ptApprox = true; atCost.add(p.token); }
      unreal += p.qty * px - p.remaining_cost;
    }
    if (ptApprox) approx = true;
    points.push({ t, pnl: realized + unreal, realized, unrealized: unreal, fees, deployed, approx: ptApprox });
  }
  const ddOf = (key) => { let peak = -Infinity, worst = 0; for (const p of points) { peak = Math.max(peak, p[key], 0); const d = p[key] - peak; if (key === "pnl") p.dd = d; p.dd_pct = null; if (d < worst) worst = d; } return worst; };
  let worst = ddOf("pnl"), guarded = false;
  // Guard: a group cannot lose more from a peak than it ever put in, unless it had
  // real gains first; a mark-to-market drawdown bigger than the SOL deployed means
  // bad prices, so fall back to the realized-only curve.
  if (-worst > deployed + 1e-9) {
    guarded = true;
    const rw = ddOf("realized");
    let peak = -Infinity; for (const p of points) { peak = Math.max(peak, p.realized, 0); p.dd = p.realized - peak; }
    worst = rw;
  }
  const notes = [];
  if (atCost.size) notes.push(`no usable SOL price history for ${[...atCost].join(", ")}: held at cost between trades (realized-only)`);
  if (guarded) notes.push(`mark-to-market drawdown exceeded the ${deployed.toFixed(4)} SOL deployed, so realized-only is used`);
  return { points, approx, max_dd: worst, max_dd_pct: null, deployed, guarded, at_cost: [...atCost], note: notes.join("; ") || null };
}

// Side-by-side numbers for the Me vs Agent panel. positions: marked positions
// (all groups); trades: annotated rows in scope.
export function compareGroups(positions, trades, curves) {
  const out = {};
  for (const g of GROUPS) {
    const pos = positions.filter((p) => p.trader === g);
    const rows = trades.filter((t) => groupOf(t) === g);
    const a = aggregates(pos, rows);
    const closed = pos.filter((p) => p.closed);
    const open = pos.filter((p) => !p.closed);
    const unknown = open.filter((p) => p.unrealized == null).length;
    const swaps = rows.filter((t) => t.action === "BUY" || t.action === "SELL");
    out[g] = {
      ...a,
      trades: swaps.length,
      buys: swaps.filter((t) => t.action === "BUY").length,
      sells: swaps.filter((t) => t.action === "SELL").length,
      realized_sol: sum(pos.map((p) => p.realized)),
      unrealized_sol: open.length ? sum(open.map((p) => p.unrealized || 0)) : 0,
      unrealized_unknown: unknown,
      avg_hold_ms: closed.length ? sum(closed.map((p) => p.close_time - p.open_time)) / closed.length : null,
      max_dd: curves && curves[g] ? curves[g].max_dd : null,
      max_dd_note: curves && curves[g] ? curves[g].note : null,
      crossed: pos.reduce((n, p) => n + p.crossed_sells.length, 0),
      crossed_sol: sum(pos.flatMap((p) => p.crossed_sells.map((c) => c.realized))),
      inferred: rows.filter((t) => t._tsrc === "inferred" || t._tsrc === "manual_override").length,
    };
    out[g].total_sol = out[g].realized_sol + out[g].unrealized_sol;
  }
  return out;
}

export function dailyPnl(points) {
  const end = new Map();
  for (const p of points) end.set(aestDay(p.t), p.pnl); // points ascending: keeps the day's last value
  const days = [...end.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let last = 0;
  return days.map(([day, e]) => { const d = { day, start: last, end: e, pnl: e - last }; last = e; return d; });
}

export function histogram(values, { width = 25, min = -100, max = 200 } = {}) {
  const bins = [];
  for (let lo = min; lo < max; lo += width) bins.push({ lo, hi: lo + width, n: 0 });
  bins.push({ lo: max, hi: Infinity, n: 0 });
  for (let v of values) {
    if (v == null) continue;
    v = Math.round(v * 1e6) / 1e6; // 49.9999999 (float) belongs in the 50% bin
    const b = v >= max ? bins[bins.length - 1] : bins.find((b) => v >= b.lo && v < b.hi) || bins[0];
    b.n++;
  }
  return bins;
}

// ---- rule adherence -------------------------------------------------------
export function entryAdherence(buys) {
  const all = Object.keys(FILTER_NAMES);
  let passedAll = 0, failedAny = 0, incomplete = 0;
  const per = Object.fromEntries(all.map((f) => [f, { pass: 0, fail: 0, unknown: 0 }]));
  for (const b of buys) {
    const s = b.entry_snapshot || { filters_passed: [], filters_failed: [] };
    for (const f of all) {
      if (s.filters_failed.includes(f)) per[f].fail++; else if (s.filters_passed.includes(f)) per[f].pass++; else per[f].unknown++;
    }
    if (s.filters_failed.length) failedAny++; else if (all.every((f) => s.filters_passed.includes(f))) passedAll++; else incomplete++;
  }
  const n = buys.length;
  return { n, passed_all: passedAll, failed_any: failedAny, incomplete, passed_all_pct: n ? (passedAll / n) * 100 : null, per };
}
export const FILTER_NAMES = {
  liquidity_100k: "Liquidity >= $100k", volume24h_250k: "24h volume >= $250k", age_12h_14d: "Age 12 h-14 d",
  mint_freeze_revoked: "Mint/freeze revoked", lp_locked_or_burned: "LP locked/burned", top10_lt_25pct: "Top 10 < 25%",
  dev_insiders_lt_15pct: "Dev+insiders < 15%", not_after_pump: "Not after a pump", rugcheck_no_warnings: "RugCheck clean",
};

// Judge each position's exits against the real-run rulebook.
export function exitAdherence(p, ex, now, rules = REAL_RULES) {
  const notes = [];
  if (p.closed) {
    const x = p.proceeds / p.cost_in;
    if (x < rules.stop_x - 0.02) notes.push({ kind: "late", text: `exited at ${fmtX(x)}: below the ${fmtX(rules.stop_x)} hard stop (late stop)` });
    else if (x < rules.take_profit[0].x - 0.02 && x >= rules.stop_x && !p.sells.some((s) => ["stop", "time_stop", "emergency", "rug"].includes(s.exit_reason))) notes.push({ kind: "early", text: `closed at ${fmtX(x)} before the 1.5x target without a stop/time-stop reason (early)` });
  } else if (p.x != null) {
    if (p.x <= rules.stop_x) notes.push({ kind: "late", text: `holding at ${fmtX(p.x)}: below the ${fmtX(rules.stop_x)} hard stop` });
    if (p.x >= rules.take_profit[0].x && p.sold_frac < 1 / 3 - 0.01) notes.push({ kind: "late", text: `at ${fmtX(p.x)} with no 1/3 taken at 1.5x` });
    if ((now - p.open_time) / H >= rules.time_stop_hours && (ex ? 1 + ex.mfe_pct / 100 : p.x) < rules.time_stop_min_x) notes.push({ kind: "late", text: `open ${Math.round((now - p.open_time) / H)} h without reaching +20% (time stop due)` });
  }
  if (ex) {
    if (ex.mae_pct <= (rules.stop_x - 1) * 100 && !p.sells.some((s) => s.exit_reason === "stop")) notes.push({ kind: "late", text: `drew down ${ex.mae_pct.toFixed(0)}% (MAE) without a stop exit` });
    if (ex.mfe_pct >= (rules.take_profit[0].x - 1) * 100 && !p.sells.some((s) => /^target/.test(s.exit_reason || ""))) notes.push({ kind: "missed", text: `reached +${ex.mfe_pct.toFixed(0)}% (MFE) but no target sell logged` });
  }
  return notes;
}

export function fmtX(x) { return x == null ? "n/a" : (x >= 10 ? x.toFixed(1) : x.toFixed(2)) + "x"; }

// ---- next-action hints (informational only) -------------------------------
export function nextAction(p, ex, now) {
  if (p.closed) return null;
  const x = p.x;
  const pt = p.planned_targets;
  if (x == null) return { level: "grey", text: "No live price: cannot judge targets." };
  if (p.run === "real" || (pt && pt.rule_set === REAL_RULES.rule_set)) {
    const r = REAL_RULES;
    const peakX = ex ? Math.max(1 + ex.mfe_pct / 100, x) : x;
    if (x <= r.stop_x) return { level: "red", text: `Below the -35% hard stop (${fmtX(x)}): rulebook says sell everything.` };
    if ((now - p.open_time) / H >= r.time_stop_hours && peakX < r.time_stop_min_x) return { level: "red", text: "6 h without +20%: time stop says sell everything." };
    if (x >= 1.5 && p.sold_frac < 1 / 3 - 0.01) return { level: "amber", text: "1.5x reached: rulebook says sell 1/3." };
    if (x >= 2 && p.sold_frac < 2 / 3 - 0.01) return { level: "amber", text: "2x reached: rulebook says sell the second 1/3." };
    if (p.sold_frac >= 2 / 3 - 0.01) { const trig = peakX * (1 - r.trail_pct / 100); return { level: "green", text: `Trailing the last 1/3: sell if it falls to ${fmtX(trig)} (25% off the ${fmtX(peakX)} peak).` }; }
    const nextX = p.sold_frac >= 1 / 3 - 0.01 ? 2 : 1.5;
    return { level: "green", text: `Hold. Next: ${nextX}x (value ${(p.remaining_cost * nextX).toFixed(4)} SOL). Stop at 0.65x (${(p.remaining_cost * 0.65).toFixed(4)} SOL).` };
  }
  if (pt && pt.take_profit && pt.take_profit.length) {
    const tx = Math.max(...pt.take_profit.map((t) => t.x));
    const keep = pt.keep_min_frac ? `, keep >= ${Math.round(pt.keep_min_frac * 100)}%` : "";
    if (x >= tx) return { level: "amber", text: `Test-run target ${tx}x reached: take profit per plan${keep}.` };
    if (pt.stop_x && x <= pt.stop_x) return { level: "red", text: `At/below the plan's ${fmtX(pt.stop_x)} stop.` };
    return { level: "grey", text: `Test-run rule: hold to ${tx}x (value ${(p.remaining_cost * tx).toFixed(3)} SOL)${keep}; no stop. Now ${fmtX(x)}, needs ${fmtX(tx / x)} more.` };
  }
  if (pt && pt.stop_x) return { level: x <= pt.stop_x ? "red" : "grey", text: `Plan: stop at ${fmtX(pt.stop_x)}; no take-profit logged.` };
  return { level: "grey", text: "No targets logged for this position." };
}

// ---- real-run rule panel --------------------------------------------------
export function rulePanel(trades, positions, now, { scope = "real" } = {}) {
  const rows = trades.filter((t) => scope === "all" || t.run === scope);
  const pos = positions.filter((p) => scope === "all" || p.run === scope);
  const dayStart = aestDayStart(now);
  const buysToday = rows.filter((t) => t.action === "BUY" && ms(t.time_aest) >= dayStart && ms(t.time_aest) <= now);
  // distinct positions opened today count as buys; top-ups count too (each BUY row is a buy)
  const nb = buysToday.length;
  const buys = { n: nb, max: REAL_RULES.max_buys_per_day, level: nb < 2 ? "green" : nb === 2 ? "amber" : "red", text: nb < 2 ? `${nb}/2 buys today` : nb === 2 ? "2/2: daily buy limit reached" : `${nb}/2: over the daily limit` };
  const closed = pos.filter((p) => p.closed).sort((a, b) => a.close_time - b.close_time);
  let ls = 0;
  for (let i = closed.length - 1; i >= 0 && closed[i].realized <= 0; i--) ls++;
  const lastLoss = ls ? closed[closed.length - 1].close_time : null;
  const pauseUntil = ls >= REAL_RULES.pause_after_losses ? lastLoss + REAL_RULES.pause_hours * H : null;
  const streak = { n: ls, pause_until: pauseUntil, level: ls === 0 ? "green" : ls === 1 ? "amber" : pauseUntil > now ? "red" : "amber", text: ls === 0 ? "No current losing streak" : ls === 1 ? "1 loss in a row (pause after 2)" : pauseUntil > now ? "2+ losses in a row: 24 h pause active" : "2+ losses in a row: pause has elapsed" };
  const wk = aestWeekStart(now);
  const topup = rows.filter((t) => t.action === "DEPOSIT" && ms(t.time_aest) >= wk).reduce((s, t) => s + t.sol, 0)
    - rows.filter((t) => t.action === "WITHDRAW" && ms(t.time_aest) >= wk).reduce((s, t) => s + t.sol, 0);
  let weekRealized = 0;
  const { rowInfo } = buildPositions(rows.filter((t) => t.action === "BUY" || t.action === "SELL"));
  for (const t of rows) if (t.action === "SELL" && ms(t.time_aest) >= wk) { const i = rowInfo.get(t.id); if (i && i.realized != null) weekRealized += i.realized; }
  const unreal = pos.filter((p) => !p.closed).reduce((s, p) => s + (p.unrealized || 0), 0);
  const unknown = pos.some((p) => !p.closed && p.unrealized == null);
  const weekPnl = weekRealized + unreal;
  const baseline = topup > 0 ? topup : null;
  const pct = baseline ? (weekPnl / baseline) * 100 : null;
  const weekly = { pnl: weekPnl, topup, baseline, pct, unknown, level: pct == null ? "grey" : pct <= REAL_RULES.weekly_stop_pct ? "red" : pct <= -25 ? "amber" : "green",
    text: pct == null ? "No top-up this week: nothing to measure against" : pct <= REAL_RULES.weekly_stop_pct ? "Down 50%+ vs this week's top-up: stop until next top-up" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs this week's top-up` };
  return { buys, streak, weekly, week_start: wk, day_start: dayStart };
}
