// Hades Trades: read-only dashboard. No wallet connection, no keys, no signing.
import * as S from "./stats.js";
import { validateDoc } from "./schema.js";
import { parseTx } from "./parse-tx.js";
import * as src from "./sources.js";
import { lineChart, barChart, hBars, calendar, progress, COLORS } from "./charts.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SOLSCAN = (sig) => `https://solscan.io/tx/${sig}`;
const TZ = "Australia/Brisbane";

// ---------- formatting ----------
export const fmt = {
  sol(v, sign = false) {
    if (v == null || !Number.isFinite(v)) return "n/a";
    const a = Math.abs(v), s = a < 0.01 && a > 0 ? a.toFixed(6) : a.toFixed(4);
    return (v < 0 ? "-" : sign && v > 0 ? "+" : "") + s;
  },
  money(v, cur, sign = false) {
    if (v == null || !Number.isFinite(v)) return "n/a";
    const sym = cur === "AUD" ? "A$" : "US$";
    return (v < 0 ? "-" : sign && v > 0 ? "+" : "") + sym + Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  pct(v, dp = 1) { return v == null || !Number.isFinite(v) ? "n/a" : (v > 0 ? "+" : "") + v.toFixed(dp) + "%"; },
  num(v, dp = 2) { return v == null || !Number.isFinite(v) ? "n/a" : v.toLocaleString("en-AU", { maximumFractionDigits: dp }); },
  x(v) { return S.fmtX(v); },
  r(v) { return v == null || !Number.isFinite(v) ? "n/a" : (v > 0 ? "+" : "") + v.toFixed(2) + "R"; },
  time(t) { return new Date(t).toLocaleString("en-AU", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " AEST"; },
  clock(t) { return new Date(t).toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit" }) + " AEST"; },
  dur(ms) {
    if (ms == null || !Number.isFinite(ms)) return "n/a";
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} h ${m % 60} m`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
  },
  price(v) { return v == null || !Number.isFinite(v) ? "n/a" : v.toExponential(4); },
};
const cls = (v) => (v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
const nTag = (n, extra = "") => `<span class="n" data-n="${n}">n = ${n}${extra}</span>`;
const few = (n, what = "closed trades") => (n < S.MIN_SAMPLE ? `<p class="few" data-few>Too few trades for reliable statistics (n = ${n} ${what}; ${S.MIN_SAMPLE}+ recommended). Treat these numbers as anecdotes.</p>` : "");

// ---------- state ----------
const state = {
  doc: null, trades: [], loadError: null, warnings: [],
  scope: localStorage.getItem("ht:scope") || "all",
  cur: localStorage.getItem("ht:cur") || "SOL",
  preview: false,
  live: { wallet: null, walletError: null, prices: {}, pricesError: null, fx: null, fxError: null, candles: {}, candleErrors: {}, unlogged: [], lastLive: null, loading: false },
  filters: { run: "all", token: "all", outcome: "all", action: "all" },
};

async function loadTrades() {
  try {
    const res = await fetch(`data/trades.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`data/trades.json HTTP ${res.status}`);
    const doc = await res.json();
    state.doc = doc;
    state.warnings = validateDoc(doc);
    state.trades = [...doc.trades].sort((a, b) => S.ms(a.time_aest) - S.ms(b.time_aest));
  } catch (e) {
    state.loadError = e.message;
    state.doc = { wallet: "CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f", trades: [], real_run_start_aest: "2026-10-06T21:12:00+10:00" };
    state.trades = [];
  }
}

// ---------- model ----------
function marksFrom() {
  const L = state.live, marks = {};
  const solUsd = L.fx && L.fx.sol_usd;
  for (const [mint, p] of Object.entries(L.prices)) {
    const price_sol = p.sol_quote ? p.price_native : p.price_sol != null ? p.price_sol : p.price_usd != null && solUsd ? p.price_usd / solUsd : null;
    marks[mint] = { price_sol, info: p };
  }
  if (L.wallet) {
    const q = {};
    for (const a of L.wallet.accounts) q[a.mint] = (q[a.mint] || 0) + a.amount;
    for (const mint of new Set([...Object.keys(q), ...state.trades.filter((t) => t.mint).map((t) => t.mint)])) {
      marks[mint] = { ...(marks[mint] || { price_sol: null }), chain_qty: q[mint] || 0 };
    }
  }
  return marks;
}

function model() {
  const now = Date.now();
  const all = state.trades;
  const marks = marksFrom();
  const { positions, rowInfo } = S.buildPositions(all);
  S.markPositions(positions, marks, now);
  const candles = state.live.candles;
  for (const p of positions) p.ex = S.excursion(candles[p.mint], p.open_time, p.closed ? p.close_time : now, p.entry_price);
  const scope = state.scope;
  const sTrades = all.filter((t) => S.inScope(t, scope));
  const sPos = positions.filter((p) => S.inScope(p, scope));
  const livePrices = Object.fromEntries(Object.entries(marks).map(([m, v]) => [m, v.price_sol]));
  const eq = S.equityCurve(sTrades, sPos, candles, livePrices, now);
  const lastPnl = eq.points.length ? eq.points[eq.points.length - 1].pnl : null;
  const agg = S.aggregates(sPos, sTrades, { netPnl: lastPnl });
  return { now, all, marks, positions, rowInfo, sTrades, sPos, eq, agg, livePrices };
}

function header(m) {
  const L = state.live, all = m.all;
  const dep = all.filter((t) => t.action === "DEPOSIT"), wd = all.filter((t) => t.action === "WITHDRAW");
  const deposited = dep.reduce((s, t) => s + t.sol, 0) - wd.reduce((s, t) => s + t.sol, 0);
  const depUsdKnown = [...dep, ...wd].every((t) => t.usd_at_time != null);
  const depositedUsd = depUsdKnown ? dep.reduce((s, t) => s + t.usd_at_time, 0) - wd.reduce((s, t) => s + t.usd_at_time, 0) : null;
  let sol, rent, tokenValue = 0, unpriced = [], estimated = false;
  if (L.wallet) {
    sol = L.wallet.sol;
    rent = L.wallet.accounts.reduce((s, a) => s + (a.lamports || 0), 0) / 1e9;
    const q = {};
    for (const a of L.wallet.accounts) if (a.amount > 0) q[a.mint] = (q[a.mint] || 0) + a.amount;
    for (const [mint, amt] of Object.entries(q)) {
      const px = m.marks[mint] && m.marks[mint].price_sol;
      if (px == null) unpriced.push(mint); else tokenValue += amt * px;
    }
  } else {
    estimated = true;
    sol = all.reduce((s, t) => s + S.solDelta(t), 0);
    rent = all.reduce((s, t) => s + (t.rent_sol || 0), 0);
    for (const p of m.positions) if (!p.closed) { if (p.value != null) tokenValue += p.value; else { tokenValue += p.remaining_cost; unpriced.push(p.mint); } }
  }
  const total = sol + rent + tokenValue;
  const pnl = total - deposited;
  const fx = L.fx;
  const usd = fx ? total * fx.sol_usd : null;
  const pnlUsd = usd != null && depositedUsd != null ? usd - depositedUsd : null;
  return { sol, rent, tokenValue, total, deposited, depositedUsd, pnl, pnlPct: deposited ? (pnl / deposited) * 100 : null, usd, aud: usd != null && fx.usd_aud ? usd * fx.usd_aud : null, pnlUsd, pnlUsdPct: pnlUsd != null && depositedUsd ? (pnlUsd / depositedUsd) * 100 : null, pnlAud: pnlUsd != null && fx.usd_aud ? pnlUsd * fx.usd_aud : null, depositedAud: depositedUsd != null && fx && fx.usd_aud ? depositedUsd * fx.usd_aud : null, unpriced, estimated };
}

// ---------- render ----------
function renderHeader(m) {
  const h = header(m), L = state.live, cur = state.cur;
  const big = cur === "SOL" ? `${fmt.sol(h.total)} <small>SOL</small>` : cur === "USD" ? fmt.money(h.usd, "USD") : fmt.money(h.aud, "AUD");
  const pnlMain = cur === "SOL" ? `${fmt.sol(h.pnl, true)} SOL` : cur === "USD" ? fmt.money(h.pnlUsd, "USD", true) : fmt.money(h.pnlAud, "AUD", true);
  const pnlPct = cur === "SOL" ? h.pnlPct : h.pnlUsdPct;
  const depMain = cur === "SOL" ? `${fmt.sol(h.deposited)} SOL` : cur === "USD" ? fmt.money(h.depositedUsd, "USD") : fmt.money(h.depositedAud, "AUD");
  const wallet = state.doc.wallet;
  const chips = ["rpc", "dex", "fx", "ohlcv"].map((k) => {
    const s = src.status[k];
    const name = { rpc: "Chain", dex: "Prices", fx: "FX", ohlcv: "History" }[k];
    if (!s) return `<span class="chip grey" data-src="${k}" title="not loaded yet">${name}: …</span>`;
    return `<span class="chip ${s.ok ? "green" : s.stale || s.degraded ? "amber" : "red"}" data-src="${k}" data-ok="${s.ok ? 1 : 0}" title="${esc(s.detail)}">${name}: ${s.ok ? "ok" : s.degraded ? "fallback" : s.stale ? "stale" : "error"}</span>`;
  }).join("");
  $("#hdr").innerHTML = `
    <div class="hero">
      <div>
        <p class="label">Wallet value ${h.unpriced.length && !h.estimated ? `<b class="warn" data-k="unpriced">excludes ${h.unpriced.length} unpriced token${h.unpriced.length > 1 ? "s" : ""}</b> ` : ""}${h.estimated ? '<b class="warn" data-k="estimated">estimated from the log (live balance unavailable)</b>' : ""}</p>
        <p class="stat-value" data-k="total">${big}</p>
        <p class="sub"><span data-k="total-sol">${fmt.sol(h.total)} SOL</span> · <span data-k="total-usd">${fmt.money(h.usd, "USD")}</span> · <span data-k="total-aud">${fmt.money(h.aud, "AUD")}</span></p>
      </div>
      <button class="btn" type="button" id="cur-toggle" data-cur="${cur}" aria-label="Switch currency">Show in: <b>${cur}</b></button>
    </div>
    <div class="hstats">
      <div><p class="label">Deposited</p><p class="v" data-k="deposited">${depMain}</p><small>${fmt.sol(h.deposited)} SOL · ${fmt.money(h.depositedUsd, "USD")} at deposit time</small></div>
      <div><p class="label">P&amp;L</p><p class="v ${cls(cur === "SOL" ? h.pnl : h.pnlUsd)}" data-k="pnl">${pnlMain} <span data-k="pnl-pct">${fmt.pct(pnlPct)}</span></p><small>SOL terms <span data-k="pnl-sol">${fmt.sol(h.pnl, true)}</span> (${fmt.pct(h.pnlPct)}) · USD <span data-k="pnl-usd">${fmt.money(h.pnlUsd, "USD", true)}</span></small></div>
      <div><p class="label">Breakdown</p><p class="v small-v">SOL <span data-k="sol">${fmt.sol(h.sol)}</span> · tokens <span data-k="tokens-value">${fmt.sol(h.tokenValue)}</span></p><small>+ <span data-k="rent">${fmt.sol(h.rent)}</span> SOL reclaimable rent in token accounts${h.unpriced.length ? ` · <b class="warn">${h.unpriced.length} unpriced</b>` : ""}</small></div>
    </div>
    <div class="hfoot">
      <a class="btn" href="https://gmgn.ai/sol/address/${esc(wallet)}" target="_blank" rel="noopener" data-k="gmgn">GMGN</a>
      <a class="btn ghost" href="https://solscan.io/account/${esc(wallet)}" target="_blank" rel="noopener">Solscan</a>
      <button class="btn ghost" type="button" id="refresh">${L.loading ? "Refreshing…" : "Refresh"}</button>
      <span class="muted" data-k="updated">Live: ${L.lastLive ? fmt.clock(L.lastLive) : "loading…"} · Log: ${state.doc.updated_aest ? fmt.time(S.ms(state.doc.updated_aest)) : "n/a"}</span>
    </div>
    <div class="chips">${chips}</div>
    <p class="muted fx-line">${L.fx ? `SOL/USD ${L.fx.sol_usd.toFixed(2)}${L.fx.usd_aud ? ` · USD/AUD ${L.fx.usd_aud.toFixed(4)}` : ""} (${esc(L.fx.source)})` : L.fxError ? `<span class="warn" data-k="fx-error">FX unavailable: ${esc(L.fxError)}</span>` : ""}. Fiat P&amp;L uses USD at deposit time; AUD uses today's rate.</p>`;
}

function renderAlerts(m) {
  const L = state.live, out = [];
  if (state.loadError) out.push(`<div class="alert red" data-alert="load">Could not load the trade log: ${esc(state.loadError)}</div>`);
  if (state.warnings.length) out.push(`<div class="alert amber" data-alert="schema"><b>Trade log has ${state.warnings.length} schema issue(s):</b><ul>${state.warnings.slice(0, 5).map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`);
  if (L.walletError) out.push(`<div class="alert red" data-alert="rpc">Live wallet data unavailable: ${esc(L.walletError)}. Values below use logged quantities.</div>`);
  if (L.pricesError) out.push(`<div class="alert red" data-alert="dex">Token prices unavailable: ${esc(L.pricesError)}.</div>`);
  // unlogged activity
  const ul = L.unlogged;
  if (ul.length) {
    out.push(`<div class="alert amber" data-alert="unlogged"><b>On-chain activity not yet logged (${ul.length})</b><p class="muted">Seen on chain but missing from trades.json. Hades should log it with <code>add-trade.mjs --from-tx &lt;sig&gt;</code>.</p><ul class="ul-list">${ul.map((u) => `<li data-unlogged="${esc(u.sig)}"><a href="${SOLSCAN(u.sig)}" target="_blank" rel="noopener">${esc(u.sig.slice(0, 10))}…</a> ${u.t ? fmt.time(u.t * 1000) : ""} · ${u.parsed ? `<b>${esc(u.parsed.action || u.parsed.kind)}</b> ${esc(u.symbol || (u.parsed.mint ? u.parsed.mint.slice(0, 6) + "…" : ""))} ${u.parsed.sol_delta != null ? fmt.sol(u.parsed.sol_delta, true) + " SOL" : ""}${u.parsed.tokens ? " · " + fmt.num(u.parsed.tokens) + " tokens" : ""}` : u.parseError ? `<span class="muted">details unavailable (${esc(u.parseError)})</span>` : '<span class="muted">loading details…</span>'}</li>`).join("")}</ul></div>`);
  }
  if (L.wallet && L.wallet.sigs == null) out.push(`<div class="alert amber" data-alert="sigs">Could not check recent signatures (${esc(L.wallet.sig_error)}); unlogged activity detection is off.</div>`);
  // holdings not in the log / mismatches
  if (L.wallet) {
    const logged = new Set(m.all.filter((t) => t.mint).map((t) => t.mint));
    const extra = L.wallet.accounts.filter((a) => a.amount > 0 && !logged.has(a.mint));
    if (extra.length) out.push(`<div class="alert amber" data-alert="holdings">Holdings not in the log: ${extra.map((a) => `<code>${esc((L.prices[a.mint] && L.prices[a.mint].symbol) || a.mint.slice(0, 6) + "…")}</code> ${fmt.num(a.amount)}`).join(", ")}</div>`);
    const mm = m.positions.filter((p) => !p.closed && p.qty_mismatch);
    if (mm.length) out.push(`<div class="alert amber" data-alert="mismatch">Logged quantity differs from chain for ${mm.map((p) => `${esc(p.token)} (log ${fmt.num(p.qty)} vs chain ${fmt.num(p.chain_qty)})`).join(", ")}. Values use the chain quantity.</div>`);
  }
  $("#alerts").innerHTML = out.join("");
}

function renderScope(m) {
  const count = (r) => m.all.filter((t) => (t.action === "BUY" || t.action === "SELL") && (r === "all" || t.run === r)).length;
  $("#scope").innerHTML = ["all", "test", "real"].map((r) => `<button class="tab" type="button" data-scope="${r}" aria-selected="${state.scope === r}">${r === "all" ? "All runs" : r === "test" ? "Test run" : "Real run"} <small>${count(r)}</small></button>`).join("");
}

function positionCard(p, m) {
  const next = S.nextAction(p, p.ex, m.now);
  const pt = p.planned_targets;
  const real = p.run === "real" || (pt && pt.rule_set === S.REAL_RULES.rule_set);
  let bar;
  if (real) {
    bar = progress({ x: p.x, lo: 0.5, hi: 2.5, markers: [{ x: 0.65, label: "stop 0.65x", kind: "stop" }, { x: 1, label: "1x" }, { x: 1.5, label: "1.5x ⅓", kind: "tp" }, { x: 2, label: "2x ⅓", kind: "tp" }] });
  } else {
    const tps = pt && pt.take_profit ? pt.take_profit.map((t) => t.x) : [];
    const hi = Math.max(2, ...tps) * 1.05;
    const lo = Math.min(0.05, p.x || 1) * 0.9;
    bar = progress({ x: p.x, lo, hi, log: true, markers: [{ x: 1, label: "1x" }, ...(pt && pt.stop_x ? [{ x: pt.stop_x, label: `stop ${pt.stop_x}x`, kind: "stop" }] : []), ...tps.map((x) => ({ x, label: `${x}x`, kind: "tp" }))] });
  }
  const priceInfo = m.marks[p.mint] && m.marks[p.mint].info;
  return `<article class="pos" data-pos="${esc(p.token)}">
    <div class="pos-head"><div><b>${esc(p.token)}</b> <span class="tag ${p.run}">${p.run}</span> <small class="muted">${p.buys.length} buy${p.buys.length > 1 ? "s" : ""} · held ${fmt.dur(p.hold_ms)}</small></div>
      <div class="xm ${cls(p.x == null ? null : p.x - 1)}" data-k="x">${fmt.x(p.x)}</div></div>
    <div class="pos-grid">
      <div><small>Cost</small><b data-k="cost">${fmt.sol(p.remaining_cost)}</b></div>
      <div><small>Value</small><b data-k="value">${fmt.sol(p.value)}</b></div>
      <div><small>P&amp;L</small><b class="${cls(p.total_pnl)}" data-k="pnl">${fmt.sol(p.total_pnl, true)} <span>${fmt.pct(p.pnl_pct)}</span></b></div>
      <div><small>MFE / MAE</small><b data-k="mfe">${p.ex ? `${fmt.pct(p.ex.mfe_pct, 0)} / ${fmt.pct(p.ex.mae_pct, 0)}` : "n/a"}</b></div>
    </div>
    ${bar}
    <p class="hint ${next ? next.level : "grey"}" data-k="hint">${next ? esc(next.text) : ""}</p>
    <p class="muted tiny">${fmt.num(p.chain_qty != null ? p.chain_qty : p.qty)} tokens · entry ${fmt.price(p.entry_price)} SOL/token · now ${fmt.price(p.price_now)}${priceInfo ? ` · liq $${fmt.num(priceInfo.liq_usd, 0)} (${esc(priceInfo.dex)})` : ""}${pt && pt.note ? ` · plan: ${esc(pt.note)}` : ""}</p>
  </article>`;
}

function renderPositions(m) {
  const open = m.sPos.filter((p) => !p.closed).sort((a, b) => (b.value || 0) - (a.value || 0));
  $("#positions").innerHTML = `<div class="panel-head"><div><h2>Open positions</h2><p>Targets and next-action hints are informational only. ${nTag(open.length)}</p></div></div>
    ${open.length ? `<div class="pos-list">${open.map((p) => positionCard(p, m)).join("")}</div>` : '<p class="muted">No open positions in this scope.</p>'}`;
}

function renderRulePanel(m) {
  const start = S.ms(state.doc.real_run_start_aest || "2026-10-06T21:12:00+10:00");
  const armed = m.now >= start;
  const scope = state.preview ? "test" : "real";
  const r = S.rulePanel(m.all, m.positions, m.now, { scope });
  const item = (k, title, o, detail) => `<div class="rule ${o.level}" data-rule="${k}" data-level="${o.level}"><span class="light"></span><div><b>${title}</b><p>${esc(o.text)}</p>${detail ? `<small>${detail}</small>` : ""}</div></div>`;
  $("#rules").innerHTML = `<div class="panel-head"><div><h2>Real-run limits</h2><p>${armed ? "Real run is live." : `Not armed until ${fmt.time(start)}.`} ${state.preview ? '<b class="warn">Previewing with test-run data.</b>' : ""}</p></div>
      <label class="switch"><input type="checkbox" id="preview" ${state.preview ? "checked" : ""}/> Preview on test data</label></div>
    <div class="rules">
      ${item("buys", "Buys today (max 2)", r.buys, `n = ${r.buys.n} since ${fmt.time(r.day_start)}`)}
      ${item("streak", "Losing streak (pause after 2)", r.streak, r.streak.pause_until ? `pause until ${fmt.time(r.streak.pause_until)}` : `n = ${r.streak.n}`)}
      ${item("weekly", "Weekly loss vs top-up (stop at -50%)", r.weekly, `week from ${fmt.time(r.week_start)} · P&amp;L ${fmt.sol(r.weekly.pnl, true)} SOL vs top-up ${fmt.sol(r.weekly.topup)} SOL${r.weekly.unknown ? " · some positions unpriced" : ""}`)}
    </div>
    <p class="muted tiny">Rules 14-16 of the real-run rulebook. Weekly P&amp;L = realized this week + current unrealized on open positions (approximate).</p>`;
}

function statCard(label, value, sub, k) {
  return `<div class="stat-card"><p class="label">${label}</p><p class="stat-value sm" data-k="${k}">${value}</p>${sub ? `<p class="sub">${sub}</p>` : ""}</div>`;
}

function renderAggregates(m) {
  const a = m.agg, st = a.streaks;
  const pf = a.profit_factor === Infinity ? "∞ (no losses)" : a.profit_factor == null ? "n/a" : a.profit_factor.toFixed(2);
  $("#aggs").innerHTML = `<div class="panel-head"><div><h2>Performance</h2><p>Closed positions only (average cost). ${nTag(a.n_closed, " closed")} · ${a.n_open} open</p></div></div>
    ${few(a.n_closed)}
    <div class="stats">
      ${statCard("Win rate", a.win_rate == null ? "n/a" : a.win_rate.toFixed(1) + "%", `${a.wins} W / ${a.losses} L · n = ${a.n_closed}`, "win-rate")}
      ${statCard("Avg win", fmt.sol(a.avg_win_sol, true), fmt.pct(a.avg_win_pct) + ` · n = ${a.wins}`, "avg-win")}
      ${statCard("Avg loss", fmt.sol(a.avg_loss_sol, true), fmt.pct(a.avg_loss_pct) + ` · n = ${a.losses}`, "avg-loss")}
      ${statCard("Profit factor", pf, "gross wins / gross losses", "pf")}
      ${statCard("Expectancy / trade", fmt.sol(a.expectancy_sol, true) + " SOL", fmt.pct(a.expectancy_pct) + ` · avg ${fmt.r(a.avg_r)}`, "expectancy")}
      ${statCard("Max drawdown", fmt.sol(m.eq.max_dd, true) + " SOL", `${fmt.pct(m.eq.max_dd_pct)} of peak equity (mark-to-market${m.eq.approx ? ", approx" : ""}) · closed-only ${fmt.sol(a.max_dd_closed.dd, true)}`, "maxdd")}
      ${statCard("Streak", st.current ? `${st.current.n} ${st.current.kind}${st.current.n > 1 ? (st.current.kind === "win" ? "s" : "es") : ""}` : "n/a", `longest: ${st.longest_win} W / ${st.longest_loss} L`, "streak")}
      ${statCard("Fees paid", fmt.sol(a.fees_sol) + " SOL", `${a.fees_pct_of_pnl == null ? "n/a" : a.fees_pct_of_pnl.toFixed(1) + "%"} of |net P&amp;L| · network + tips + platform`, "fees")}
    </div>`;
}

function renderCharts(m) {
  const pts = m.eq.points;
  const tf = (t) => new Date(t).toLocaleString("en-AU", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric" });
  const equity = lineChart({ label: "equity", series: [
    { name: "P&L incl. mark-to-market (SOL)", color: COLORS.amber, area: true, points: pts.map((p) => ({ x: p.t, y: p.pnl })) },
    { name: "Realized P&L", color: COLORS.mint, dash: "5 4", points: pts.map((p) => ({ x: p.t, y: p.realized })) },
  ], yFmt: (v) => v.toFixed(3), xFmt: tf });
  const dd = lineChart({ label: "drawdown", height: 120, series: [{ name: "Drawdown (SOL)", color: COLORS.red, area: true, points: pts.map((p) => ({ x: p.t, y: p.dd })) }], yFmt: (v) => v.toFixed(3), xFmt: tf });
  const closedPct = m.sPos.filter((p) => p.closed).map((p) => p.pnl_pct);
  const openPct = m.sPos.filter((p) => !p.closed && p.pnl_pct != null).map((p) => p.pnl_pct);
  const hc = S.histogram(closedPct), ho = S.histogram(openPct);
  const bars = hc.map((b, i) => ({ label: b.hi === Infinity ? `${b.lo}+` : `${b.lo}`, value: b.n, value2: ho[i].n, title: `${b.lo}% to ${b.hi === Infinity ? "∞" : b.hi + "%"}: ${b.n} closed, ${ho[i].n} open`, showValue: false }));
  const hist = barChart({ label: "histogram", bars: bars.map((b) => ({ ...b, value: b.value + b.value2, valueLabel: b.value2 ? `${b.value}+${b.value2}` : String(b.value) })), intTicks: true, yFmt: (v) => String(Math.round(v)), colorFor: (b) => (b.value2 && !(b.value - b.value2) ? "rgba(226,163,54,0.45)" : parseFloat(b.label) < 0 ? COLORS.red : COLORS.mint) });
  const fees = lineChart({ label: "fees", step: true, series: [{ name: "Cumulative fees (SOL)", color: COLORS.amber, points: pts.map((p) => ({ x: p.t, y: p.fees })) }], yFmt: (v) => v.toFixed(4), xFmt: tf });
  const tokRows = S.breakdown(m.sPos, "token").map((r) => ({ label: r.key, a: r.realized, b: r.unrealized })).sort((x, y) => y.a + y.b - (x.a + x.b));
  const tok = hBars({ rows: tokRows, fmt: (v) => fmt.sol(v, true) });
  const days = S.dailyPnl(pts);
  const cal = calendar({ days, todayIso: S.aestDay(m.now), fmt: (v) => fmt.sol(v, true) });
  const nClosed = closedPct.length;
  $("#charts").innerHTML = `
    <div class="panel wide"><div class="panel-head"><div><h2>Equity curve</h2><p>P&amp;L vs deposits over time, realized plus mark-to-market. ${nTag(m.sTrades.length, " log rows")}</p></div></div>
      ${m.eq.approx ? '<p class="muted tiny" data-k="eq-approx">Where price history is unavailable, open tokens are marked at cost (flat), so the curve is approximate there.</p>' : ""}
      ${equity}${dd}</div>
    <div class="panel"><div class="panel-head"><div><h2>P&amp;L distribution</h2><p>Per position, % of cost. ${nTag(nClosed, " closed")} + ${openPct.length} open (faded)</p></div></div>${hist}</div>
    <div class="panel"><div class="panel-head"><div><h2>Cumulative fees</h2><p>Network + tips + platform. ${nTag(m.sTrades.filter((t) => t.action === "BUY" || t.action === "SELL").length, " swaps")}</p></div></div>${fees}</div>
    <div class="panel"><div class="panel-head"><div><h2>P&amp;L by token</h2><p>${nTag(tokRows.length, " tokens")}</p></div></div>${tok}</div>
    <div class="panel"><div class="panel-head"><div><h2>Daily P&amp;L</h2><p>AEST days, change in P&amp;L incl. mark-to-market. ${nTag(days.length, " days")}</p></div></div>${cal}</div>`;
}

function renderAdherence(m) {
  const buys = m.sTrades.filter((t) => t.action === "BUY");
  const ea = S.entryAdherence(buys);
  const exitNotes = m.sPos.map((p) => ({ p, notes: S.exitAdherence(p, p.ex, m.now) }));
  const counts = { early: 0, late: 0, missed: 0 };
  for (const e of exitNotes) for (const n of e.notes) counts[n.kind]++;
  // "if every rule had been followed"
  const lots = [];
  for (const p of m.sPos) for (const b of p.buys) {
    const cost = S.tradeCost(b);
    const actual = p.total_pnl != null ? p.total_pnl * (cost / p.cost_in) : null;
    const sim = S.simulateLot({ entry: cost / b.tokens, cost, fromMs: S.ms(b.time_aest), candles: state.live.candles[p.mint], now: m.now, lastPrice: m.livePrices[p.mint] });
    lots.push({ b, p, cost, actual, sim });
  }
  const covered = lots.filter((l) => l.sim && l.actual != null);
  const simSum = covered.reduce((s, l) => s + l.sim.pnl, 0), actSum = covered.reduce((s, l) => s + l.actual, 0);
  const filterRows = Object.entries(S.FILTER_NAMES).map(([k, name]) => { const c = ea.per[k]; return `<tr data-filter="${k}"><td>${name}</td><td class="pos">${c.pass}</td><td class="neg">${c.fail}</td><td class="muted">${c.unknown}</td></tr>`; }).join("");
  $("#adherence").innerHTML = `<div class="panel-head"><div><h2>Rule adherence</h2><p>Judged against the real-run rulebook (the test run followed user-set rules). ${nTag(buys.length, " buys")}</p></div></div>
    ${few(buys.length, "buys")}
    <div class="stats three">
      ${statCard("Passed all entry filters", ea.passed_all_pct == null ? "n/a" : ea.passed_all_pct.toFixed(0) + "%", `${ea.passed_all} of ${ea.n} · ${ea.failed_any} failed ≥1 · ${ea.incomplete} incomplete`, "entry-pass")}
      ${statCard("Exit issues", `${counts.late} late · ${counts.early} early`, `${counts.missed} missed targets · n = ${m.sPos.length} positions`, "exit-issues")}
      ${statCard("If every rule had been followed", covered.length ? fmt.sol(simSum, true) + " SOL" : "n/a", covered.length ? `vs actual ${fmt.sol(actSum, true)} SOL · ${covered.length}/${lots.length} lots simulated · approximate` : `price history unavailable for all ${lots.length} lots`, "if-rules")}
    </div>
    <div class="split">
      <div class="table-wrap"><table class="compact"><thead><tr><th>Entry filter</th><th>Pass</th><th>Fail</th><th>Unknown</th></tr></thead><tbody>${filterRows}</tbody></table></div>
      <div><ul class="notes">${exitNotes.filter((e) => e.notes.length).map((e) => `<li data-exit-note="${esc(e.p.token)}"><b>${esc(e.p.token)}</b>: ${e.notes.map((n) => `<span class="tag ${n.kind}">${n.kind}</span> ${esc(n.text)}`).join("; ")}</li>`).join("") || '<li class="muted">No exit issues found.</li>'}</ul>
      <div class="table-wrap"><table class="compact"><thead><tr><th>Lot</th><th>Rulebook sim</th><th>Actual</th><th>Exits</th></tr></thead><tbody>${lots.map((l) => `<tr data-lot="${esc(l.b.id)}"><td>${esc(l.p.token)} ${fmt.time(S.ms(l.b.time_aest))}</td><td class="${cls(l.sim && l.sim.pnl)}">${l.sim ? fmt.sol(l.sim.pnl, true) : "n/a"}</td><td class="${cls(l.actual)}">${fmt.sol(l.actual, true)}</td><td class="tiny">${l.sim ? l.sim.events.map((e) => `${e.why} @${fmt.x(e.x)}`).join(", ") + (l.sim.open ? (l.sim.events.length ? ", " : "") + "still open" : "") : "no price history"}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted tiny">Simulation: 1/3 at 1.5x, 1/3 at 2x, trail the last 1/3 at 25% from peak, hard stop 0.65x, time stop at 6 h if never +20%; GeckoTerminal candles in SOL, stop checked before targets inside a candle, 1% sell friction. Approximate; wicks and fills may differ.</p></div>
    </div>`;
}

function renderBreakdowns(m) {
  const dims = [["token", "Token"], ["hour", "Entry hour (AEST)"], ["dow", "Day of week"], ["hold", "Hold duration"], ["liquidity", "Liquidity at entry"], ["age", "Token age at entry"], ["run", "Test vs real"]];
  $("#breakdowns").innerHTML = `<div class="panel-head"><div><h2>Breakdowns</h2><p>Per position (first buy defines the bucket). Win rate uses closed positions; total includes unrealized. ${nTag(m.sPos.length, " positions")}</p></div></div>
    ${few(m.agg.n_closed)}
    <div class="bd-grid">${dims.map(([k, name]) => { const rows = S.breakdown(m.sPos, k); return `<div class="table-wrap bd" data-bd="${k}"><h3>${name}</h3><table class="compact"><thead><tr><th>${name}</th><th>n</th><th>Closed</th><th>Win%</th><th>Total SOL</th><th>ROI</th></tr></thead><tbody>${rows.map((r) => `<tr data-row="${esc(r.key)}"><td>${esc(r.key)}</td><td>${r.n}</td><td>${r.closed}</td><td>${r.win_rate == null ? "n/a" : r.win_rate.toFixed(0) + "%"}</td><td class="${cls(r.total)}">${fmt.sol(r.total, true)}${r.unknown_value ? "*" : ""}</td><td>${fmt.pct(r.roi_pct)}</td></tr>`).join("")}</tbody></table></div>`; }).join("")}</div>`;
}

function renderClosed(m) {
  const list = [...m.sPos].sort((a, b) => b.open_time - a.open_time);
  $("#closed").innerHTML = `<div class="panel-head"><div><h2>Per-position stats</h2><p>R = P&amp;L% / 35% (the real-run hard stop). MFE/MAE from price history vs average cost. ${nTag(list.length)}</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Token</th><th>Run</th><th>Opened</th><th>Hold</th><th>Cost</th><th>Out / value</th><th>P&amp;L</th><th>%</th><th>R</th><th>MFE</th><th>MAE</th><th>Fees</th><th>Exit</th></tr></thead>
    <tbody>${list.map((p) => `<tr data-position="${esc(p.token)}" data-closed="${p.closed ? 1 : 0}"><td><b>${esc(p.token)}</b></td><td><span class="tag ${p.run}">${p.run}</span></td><td>${fmt.time(p.open_time)}</td><td data-k="hold">${fmt.dur(p.hold_ms)}${p.closed ? "" : " (open)"}</td><td>${fmt.sol(p.cost_in)}</td><td>${p.closed ? fmt.sol(p.proceeds) : fmt.sol(p.value == null ? null : p.value + p.proceeds)}</td><td class="${cls(p.total_pnl)}" data-k="pnl">${fmt.sol(p.total_pnl, true)}</td><td data-k="pct">${fmt.pct(p.pnl_pct)}</td><td data-k="r">${fmt.r(p.pnl_pct == null ? null : p.pnl_pct / S.STOP_PCT)}</td><td data-k="mfe">${p.ex ? fmt.pct(p.ex.mfe_pct, 0) : "n/a"}</td><td data-k="mae">${p.ex ? fmt.pct(p.ex.mae_pct, 0) : "n/a"}</td><td data-k="fees">${fmt.sol(p.fees)}</td><td>${esc(p.sells.map((s) => s.exit_reason || "?").join(", ") || "open")}</td></tr>`).join("")}</tbody></table></div>`;
}

function outcomeOf(t, m) {
  const i = m.rowInfo.get(t.id);
  const p = i && i.position;
  if (!p) return null;
  if (!p.closed) return "open";
  return p.realized > 0 ? "win" : "loss";
}

function renderHistory(m) {
  const f = state.filters;
  const tokens = [...new Set(m.all.filter((t) => t.token && t.action !== "DEPOSIT" && t.action !== "WITHDRAW").map((t) => t.token))].sort();
  const rows = m.all.filter((t) => (f.run === "all" || t.run === f.run) && (f.token === "all" || t.token === f.token) && (f.action === "all" || t.action === f.action) && (f.outcome === "all" || outcomeOf(t, m) === f.outcome)).reverse();
  const sel = (id, opts, v) => `<select class="filter" id="${id}" aria-label="${id}">${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const card = (t) => {
    const i = m.rowInfo.get(t.id) || {};
    const p = i.position;
    const slip = t.price_expected ? ((t.price_filled / t.price_expected - 1) * 100 * (t.action === "SELL" ? -1 : 1)) : null;
    const extra = [];
    if (t.action === "SELL" && i.realized != null) extra.push(`<span class="${cls(i.realized)}" data-k="leg-pnl">${fmt.sol(i.realized, true)} SOL (${fmt.pct(i.pnl_pct)}, ${fmt.r(i.pnl_pct / S.STOP_PCT)})</span>`, `hold ${fmt.dur(S.ms(t.time_aest) - p.open_time)}`);
    if (p && (t.action === "BUY" || t.action === "SELL")) extra.push(`MFE/MAE ${p.ex ? `${fmt.pct(p.ex.mfe_pct, 0)}/${fmt.pct(p.ex.mae_pct, 0)}` : "n/a"}`);
    if (t.fee_sol != null && (t.action === "BUY" || t.action === "SELL")) extra.push(`fees ${fmt.sol(t.fee_sol)}`);
    if (t.action === "BUY" || t.action === "SELL") extra.push(`slippage ${slip == null ? "n/a" : fmt.pct(slip, 2)}`);
    const snap = t.entry_snapshot;
    return `<details class="trade" data-trade="${esc(t.id)}" data-action="${t.action}" data-outcome="${outcomeOf(t, m) || ""}">
      <summary><span class="act ${t.action.toLowerCase()}">${t.action}</span><b>${esc(t.token || "SOL")}</b> <span class="tag ${t.run}">${t.run}</span>
        <span class="amt">${t.action === "BUY" || t.action === "WITHDRAW" ? "-" : "+"}${fmt.sol(t.sol)} SOL</span>
        <small class="muted">${fmt.time(S.ms(t.time_aest))}${t.exit_reason ? ` · ${esc(t.exit_reason)}` : ""}</small>
        <small class="stats-line">${extra.join(" · ")}</small></summary>
      <div class="trade-body">
        <p>${t.reason ? esc(t.reason) : '<span class="muted">No reason logged.</span>'}</p>
        <dl>
          ${t.tokens != null ? `<dt>Tokens</dt><dd>${fmt.num(t.tokens, 6)}</dd>` : ""}
          <dt>USD at time</dt><dd>${fmt.money(t.usd_at_time, "USD")}</dd>
          ${t.price_filled != null ? `<dt>Price filled</dt><dd>${fmt.price(t.price_filled)} SOL/token</dd><dt>Price expected</dt><dd>${fmt.price(t.price_expected)}</dd>` : ""}
          ${t.fee_breakdown ? `<dt>Fees</dt><dd>network ${fmt.sol(t.fee_breakdown.network_sol)} · tip ${fmt.sol(t.fee_breakdown.tip_sol)} · platform ${fmt.sol(t.fee_breakdown.platform_sol)}</dd>` : ""}
          ${t.rent_sol ? `<dt>Rent</dt><dd>${fmt.sol(t.rent_sol, true)} SOL (reclaimable)</dd>` : ""}
          ${snap ? `<dt>Entry snapshot</dt><dd>liq ${snap.liquidity_usd == null ? "n/a" : "$" + fmt.num(snap.liquidity_usd, 0)} · vol24 ${snap.volume24h_usd == null ? "n/a" : "$" + fmt.num(snap.volume24h_usd, 0)} · age ${snap.age_hours == null ? "n/a" : snap.age_hours + " h"} · top10 ${snap.top10_pct == null ? "n/a" : snap.top10_pct + "%"} · RugCheck ${snap.rugcheck_score == null ? "n/a" : snap.rugcheck_score}</dd>
            <dt>Filters</dt><dd>${snap.filters_passed.map((x) => `<span class="tag pass">${esc(S.FILTER_NAMES[x] || x)}</span>`).join(" ")} ${snap.filters_failed.map((x) => `<span class="tag fail">${esc(S.FILTER_NAMES[x] || x)}</span>`).join(" ")}${!snap.filters_passed.length && !snap.filters_failed.length ? '<span class="muted">none recorded</span>' : ""}</dd>` : ""}
          ${t.planned_targets ? `<dt>Plan</dt><dd>${esc(t.planned_targets.note || t.planned_targets.rule_set)}</dd>` : ""}
          ${t.unverified && t.unverified.length ? `<dt>Unverified</dt><dd class="muted">${esc(t.unverified.join(", "))}</dd>` : ""}
          <dt>Tx</dt><dd><a href="${SOLSCAN(t.tx)}" target="_blank" rel="noopener" data-k="tx">${esc(t.tx.slice(0, 16))}…</a></dd>
        </dl>
      </div></details>`;
  };
  $("#history").innerHTML = `<div class="panel-head"><div><h2>Trade history</h2><p>Tap a row for details. ${nTag(rows.length, " shown")} of ${m.all.length}</p></div></div>
    <div class="filters">
      ${sel("f-run", [["all", "All runs"], ["test", "Test"], ["real", "Real"]], f.run)}
      ${sel("f-token", [["all", "All tokens"], ...tokens.map((t) => [t, t])], f.token)}
      ${sel("f-outcome", [["all", "Win / loss / open"], ["win", "Wins"], ["loss", "Losses"], ["open", "Open"]], f.outcome)}
      ${sel("f-action", [["all", "All actions"], ["BUY", "Buys"], ["SELL", "Sells"], ["DEPOSIT", "Deposits"], ["WITHDRAW", "Withdrawals"]], f.action)}
    </div>
    <div class="trades">${rows.map(card).join("") || '<p class="muted" data-k="no-rows">No rows match these filters.</p>'}</div>`;
}

let last;
function renderAll() {
  const m = model();
  last = m;
  renderHeader(m); renderAlerts(m); renderScope(m); renderPositions(m); renderRulePanel(m);
  renderAggregates(m); renderCharts(m); renderAdherence(m); renderBreakdowns(m); renderClosed(m); renderHistory(m);
  document.body.dataset.ready = state.live.lastLive ? "live" : "static";
}

// ---------- live refresh ----------
let refreshing = null;
async function refreshLive() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const L = state.live;
    L.loading = true; renderAll();
    const wallet = state.doc.wallet;
    try { const r = await src.getWallet(wallet); L.wallet = r.v; L.walletError = r.stale ? `live fetch failed, showing cached data (${r.error.message})` : null; }
    catch (e) { L.wallet = null; L.walletError = e.message; src.status.rpc = { ok: false, detail: e.message, at: Date.now() }; }
    const mints = new Set(state.trades.filter((t) => t.mint).map((t) => t.mint));
    if (L.wallet) for (const a of L.wallet.accounts) if (a.amount > 0) mints.add(a.mint);
    try { const r = await src.getPrices([...mints]); L.prices = r.v; L.pricesError = null; }
    catch (e) { L.pricesError = e.message; src.status.dex = { ok: false, detail: e.message, at: Date.now() }; }
    const hint = Object.values(L.prices).find((p) => (p.sol_quote && p.price_usd) || p.sol_usd);
    try { const r = await src.getFx(hint); L.fx = r.v; L.fxError = null; }
    catch (e) { L.fx = null; L.fxError = e.message; }
    L.lastLive = Date.now();
    L.loading = false;
    renderAll();
    await loadUnlogged();
    await loadCandles();
    renderAll();
  })();
  try { await refreshing; } finally { refreshing = null; }
}

async function loadUnlogged() {
  const L = state.live;
  if (!L.wallet || !L.wallet.sigs) { L.unlogged = []; return; }
  const logged = new Set(state.trades.map((t) => t.tx));
  const firstLogged = state.trades.length ? S.ms(state.trades[0].time_aest) / 1000 : 0;
  const prev = new Map(L.unlogged.map((u) => [u.sig, u]));
  L.unlogged = L.wallet.sigs.filter((s) => !s.err && !logged.has(s.sig) && (!s.t || s.t >= firstLogged - 60)).map((s) => prev.get(s.sig) || { sig: s.sig, t: s.t });
  renderAll();
  for (const u of L.unlogged.slice(0, 6)) {
    if (u.parsed || u.parseError) continue;
    try {
      const cachedParsed = src.cacheGet(`parsed:${u.sig}`);
      if (cachedParsed) u.parsed = cachedParsed.v;
      else { const tx = await src.getTx(u.sig); u.parsed = parseTx(tx, state.doc.wallet); src.cacheSet(`parsed:${u.sig}`, u.parsed); }
      if (u.parsed.mint && L.prices[u.parsed.mint]) u.symbol = L.prices[u.parsed.mint].symbol;
    } catch (e) { u.parseError = e.message; }
  }
}

async function loadCandles() {
  const L = state.live;
  const { positions } = S.buildPositions(state.trades);
  const now = Date.now();
  let ok = 0, fail = 0, missing = 0;
  const errs = [];
  for (const p of positions.sort((a, b) => b.open_time - a.open_time).slice(0, 10)) {
    const info = L.prices[p.mint];
    const pool = await src.getPool(p.mint, info && info.pair);
    if (!pool) { missing++; continue; }
    try {
      const r = await src.getCandles(pool, p.mint, p.open_time - 30 * 60e3, p.closed ? Math.min(now, p.close_time + 6 * 3600e3) : now);
      const prevC = L.candles[p.mint] || [];
      const merged = new Map([...prevC, ...r.v].map((c) => [c.t, c]));
      L.candles[p.mint] = [...merged.values()].sort((a, b) => a.t - b.t);
      ok++;
      if (!r.cached) await new Promise((res) => setTimeout(res, 400));
    } catch (e) { fail++; errs.push(`${p.token}: ${e.message}`); L.candleErrors[p.mint] = e.message; }
  }
  src.status.ohlcv = { ok: fail === 0 && ok > 0, stale: false, detail: `${ok} ok, ${fail} failed, ${missing} without a pool${errs.length ? " (" + errs.join("; ") + ")" : ""}`, at: Date.now() };
}

// ---------- events ----------
function bind() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, [data-scope]");
    if (!t) return;
    if (t.id === "cur-toggle") { state.cur = { SOL: "AUD", AUD: "USD", USD: "SOL" }[state.cur]; localStorage.setItem("ht:cur", state.cur); renderAll(); }
    else if (t.id === "refresh") refreshLive();
    else if (t.dataset.scope) { state.scope = t.dataset.scope; localStorage.setItem("ht:scope", state.scope); renderAll(); }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "preview") { state.preview = t.checked; renderAll(); return; }
    const map = { "f-run": "run", "f-token": "token", "f-outcome": "outcome", "f-action": "action" };
    if (map[t.id]) { state.filters[map[t.id]] = t.value; renderHistory(last || model()); }
  });
  setInterval(() => { if (document.visibilityState === "visible") refreshLive(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && (!state.live.lastLive || Date.now() - state.live.lastLive > 30000)) refreshLive(); });
}

// Register the service worker first, independent of data loading: if it waits for
// loadTrades()/refreshLive(), a slow or failing API on the phone means Chrome never
// sees a service worker and "Install app" is not offered.
function registerSW() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
}

async function main() {
  registerSW();
  bind();
  await loadTrades();
  renderAll();
  await refreshLive();
}
main();
