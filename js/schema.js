// Hades Trades schema v1: validation shared by the web app and add-trade.mjs.
export const SCHEMA_VERSION = 1;
export const ACTIONS = ["BUY", "SELL", "DEPOSIT", "WITHDRAW"];
export const RUNS = ["test", "real"];
export const EXIT_REASONS = [
  "target_1.5x", "target_2x", "target_other", "trail", "stop", "time_stop",
  "emergency", "rug", "manual", "rebalance",
];
// Real-run entry rules 4-9 (docs/SCHEMA.md). Names used in filters_passed / filters_failed.
export const FILTERS = {
  liquidity_100k: "Liquidity >= $100k",
  volume24h_250k: "24h volume >= $250k",
  age_12h_14d: "Token age 12 h to 14 days",
  mint_freeze_revoked: "Mint + freeze authority revoked",
  lp_locked_or_burned: "LP locked or burned",
  top10_lt_25pct: "Top 10 holders < 25%",
  dev_insiders_lt_15pct: "Dev + insiders < 15%",
  not_after_pump: ">= 30% below recent high, steady buys",
  rugcheck_no_warnings: "RugCheck shows no warnings",
};
// Who made the trade (Me vs Agent). Missing trader: BUY/SELL rows count as
// "agent" (logged by Hades), DEPOSIT/WITHDRAW as "human".
export const TRADERS = ["agent", "human"];
export const TRADER_SOURCES = ["logged", "inferred", "manual_override"];
export function defaultTrader(t) { return t && (t.action === "DEPOSIT" || t.action === "WITHDRAW") ? "human" : "agent"; }
export const SNAPSHOT_NUMS = ["liquidity_usd", "volume24h_usd", "age_hours", "top10_pct", "rugcheck_score"];

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const isSig = (s) => typeof s === "string" && B58.test(s) && s.length >= 64 && s.length <= 90;
export const isMint = (s) => typeof s === "string" && B58.test(s) && s.length >= 32 && s.length <= 44;
export const ISO_AEST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+10:00$/;

const numOrNull = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
const nonNeg = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

// Filters derivable from the numeric snapshot (the rest need a human/bot check).
export function autoFilters(s) {
  const pass = [], fail = [];
  const t = (name, ok) => { if (ok === true) pass.push(name); else if (ok === false) fail.push(name); };
  if (!s) return { pass, fail };
  t("liquidity_100k", s.liquidity_usd == null ? null : s.liquidity_usd >= 100000);
  t("volume24h_250k", s.volume24h_usd == null ? null : s.volume24h_usd >= 250000);
  t("age_12h_14d", s.age_hours == null ? null : s.age_hours >= 12 && s.age_hours <= 336);
  t("top10_lt_25pct", s.top10_pct == null ? null : s.top10_pct < 25);
  return { pass, fail };
}

export function emptySnapshot() {
  return { liquidity_usd: null, volume24h_usd: null, age_hours: null, top10_pct: null, rugcheck_score: null, filters_passed: [], filters_failed: [] };
}

export function validateSnapshot(s, path = "entry_snapshot") {
  const e = [];
  if (s === null || typeof s !== "object" || Array.isArray(s)) return [`${path} must be an object`];
  for (const k of SNAPSHOT_NUMS) {
    if (!(k in s)) e.push(`${path}.${k} is required (use null if unknown)`);
    else if (!nonNeg(s[k])) e.push(`${path}.${k} must be a non-negative number or null`);
  }
  if (s.top10_pct != null && s.top10_pct > 100) e.push(`${path}.top10_pct must be 0-100`);
  for (const k of ["filters_passed", "filters_failed"]) {
    if (!Array.isArray(s[k])) { e.push(`${path}.${k} must be an array`); continue; }
    for (const f of s[k]) if (!(f in FILTERS)) e.push(`${path}.${k}: unknown filter "${f}" (allowed: ${Object.keys(FILTERS).join(", ")})`);
    if (new Set(s[k]).size !== s[k].length) e.push(`${path}.${k} has duplicates`);
  }
  if (Array.isArray(s.filters_passed) && Array.isArray(s.filters_failed)) {
    const both = s.filters_passed.filter((f) => s.filters_failed.includes(f));
    if (both.length) e.push(`${path}: filter(s) both passed and failed: ${both.join(", ")}`);
  }
  const extra = Object.keys(s).filter((k) => !SNAPSHOT_NUMS.includes(k) && !["filters_passed", "filters_failed", "source", "notes"].includes(k));
  if (extra.length) e.push(`${path}: unknown key(s) ${extra.join(", ")}`);
  return e;
}

export function validatePlanned(p, path = "planned_targets") {
  if (p === null) return [];
  const e = [];
  if (typeof p !== "object" || Array.isArray(p)) return [`${path} must be an object or null`];
  if (!Array.isArray(p.take_profit)) e.push(`${path}.take_profit must be an array of {x, sell_frac}`);
  else p.take_profit.forEach((t, i) => {
    if (!(typeof t.x === "number" && t.x > 1)) e.push(`${path}.take_profit[${i}].x must be > 1`);
    if (!(t.sell_frac === null || (typeof t.sell_frac === "number" && t.sell_frac > 0 && t.sell_frac <= 1))) e.push(`${path}.take_profit[${i}].sell_frac must be in (0,1] or null`);
  });
  if (!(p.stop_x === null || (typeof p.stop_x === "number" && p.stop_x > 0 && p.stop_x < 1))) e.push(`${path}.stop_x must be in (0,1) or null`);
  if (!(p.trail_pct === null || (typeof p.trail_pct === "number" && p.trail_pct > 0 && p.trail_pct < 100))) e.push(`${path}.trail_pct must be in (0,100) or null`);
  if (!(p.keep_min_frac === null || (typeof p.keep_min_frac === "number" && p.keep_min_frac >= 0 && p.keep_min_frac < 1))) e.push(`${path}.keep_min_frac must be in [0,1) or null`);
  if (!(p.time_stop_hours === null || (typeof p.time_stop_hours === "number" && p.time_stop_hours > 0))) e.push(`${path}.time_stop_hours must be > 0 or null`);
  if (typeof p.rule_set !== "string" || !p.rule_set) e.push(`${path}.rule_set must be a non-empty string`);
  return e;
}

export function validateTrade(t) {
  const e = [];
  const req = ["id", "time_aest", "action", "token", "mint", "sol", "tokens", "usd_at_time", "fee_sol", "price_expected", "price_filled", "tx", "reason", "run", "entry_snapshot", "exit_reason", "planned_targets"];
  if (!t || typeof t !== "object") return ["row must be an object"];
  for (const k of req) if (!(k in t)) e.push(`${k} is required (use null if unknown)`);
  if (typeof t.id !== "string" || !t.id) e.push("id must be a non-empty string");
  if (typeof t.time_aest !== "string" || !ISO_AEST.test(t.time_aest) || Number.isNaN(Date.parse(t.time_aest))) e.push('time_aest must look like "2026-09-29T21:13:20+10:00"');
  if (!ACTIONS.includes(t.action)) e.push(`action must be one of ${ACTIONS.join("|")}`);
  if (!RUNS.includes(t.run)) e.push(`run must be "test" or "real"`);
  if (!isSig(t.tx)) e.push("tx must be a base58 transaction signature");
  if (!(typeof t.sol === "number" && t.sol > 0)) e.push("sol must be a positive number");
  for (const k of ["usd_at_time", "fee_sol", "price_expected", "price_filled", "rent_sol"]) if (k in t && !numOrNull(t[k])) e.push(`${k} must be a number or null`);
  for (const k of ["usd_at_time", "fee_sol", "price_expected", "price_filled"]) if (t[k] != null && t[k] < 0) e.push(`${k} must be >= 0`);
  if (!(t.reason === null || typeof t.reason === "string")) e.push("reason must be a string or null");
  const trade = t.action === "BUY" || t.action === "SELL";
  if (trade) {
    if (typeof t.token !== "string" || !t.token) e.push("token symbol is required for BUY/SELL");
    if (!isMint(t.mint)) e.push("mint must be a base58 mint address for BUY/SELL");
    if (!(typeof t.tokens === "number" && t.tokens > 0)) e.push("tokens must be a positive number for BUY/SELL");
  } else {
    if (t.token !== null && t.token !== "SOL") e.push('token must be null or "SOL" for DEPOSIT/WITHDRAW');
    if (t.mint !== null) e.push("mint must be null for DEPOSIT/WITHDRAW");
    if (t.tokens !== null) e.push("tokens must be null for DEPOSIT/WITHDRAW");
  }
  if (t.action === "BUY") e.push(...validateSnapshot(t.entry_snapshot));
  else if (t.entry_snapshot !== null) e.push("entry_snapshot must be null unless action is BUY");
  if (t.action === "SELL") {
    if (!(t.exit_reason === null || EXIT_REASONS.includes(t.exit_reason))) e.push(`exit_reason must be null or one of ${EXIT_REASONS.join("|")}`);
  } else if (t.exit_reason !== null) e.push("exit_reason must be null unless action is SELL");
  if (t.action === "BUY") e.push(...validatePlanned(t.planned_targets));
  else if (t.planned_targets !== null) e.push("planned_targets must be null unless action is BUY");
  if ("trader" in t && !TRADERS.includes(t.trader)) e.push(`trader must be one of ${TRADERS.join("|")}`);
  if ("trader_source" in t && !TRADER_SOURCES.includes(t.trader_source)) e.push(`trader_source must be one of ${TRADER_SOURCES.join("|")}`);
  if ("trader_source" in t && !("trader" in t)) e.push("trader_source needs trader");
  if ("linked_txs" in t) {
    if (!Array.isArray(t.linked_txs) || !t.linked_txs.every(isSig)) e.push("linked_txs must be an array of transaction signatures");
    else if (t.linked_txs.includes(t.tx) || new Set(t.linked_txs).size !== t.linked_txs.length) e.push("linked_txs must not repeat tx or each other");
  }
  if ("wallet_sol_delta" in t && !(typeof t.wallet_sol_delta === "number" && Number.isFinite(t.wallet_sol_delta))) e.push("wallet_sol_delta must be a number");
  if ("proceeds_external" in t && t.proceeds_external !== null) {
    const x = t.proceeds_external;
    if (t.action !== "SELL") e.push("proceeds_external is only allowed on SELL rows");
    if (!x || typeof x !== "object") e.push("proceeds_external must be an object");
    else {
      if (typeof x.asset !== "string" || !x.asset) e.push("proceeds_external.asset must be a string");
      if (!isMint(x.mint)) e.push("proceeds_external.mint must be a mint address");
      if (!isMint(x.to)) e.push("proceeds_external.to must be an address");
      if (!(typeof x.amount === "number" && x.amount >= 0)) e.push("proceeds_external.amount must be >= 0");
      if (!(typeof x.sol_equiv === "number" && x.sol_equiv >= 0)) e.push("proceeds_external.sol_equiv must be >= 0");
      if (!nonNeg(x.usd_equiv === undefined ? null : x.usd_equiv)) e.push("proceeds_external.usd_equiv must be >= 0 or null");
      if (typeof t.wallet_sol_delta !== "number") e.push("wallet_sol_delta is required with proceeds_external");
      else if (typeof t.sol === "number" && Math.abs(t.sol - x.sol_equiv - t.wallet_sol_delta) > 2e-9) e.push("sol must equal proceeds_external.sol_equiv + wallet_sol_delta");
    }
  }
  if ("unverified" in t && !(Array.isArray(t.unverified) && t.unverified.every((x) => typeof x === "string"))) e.push("unverified must be an array of field names");
  if ("fee_breakdown" in t && t.fee_breakdown !== null) {
    const f = t.fee_breakdown;
    for (const k of ["network_sol", "tip_sol", "platform_sol"]) if (!numOrNull(f[k])) e.push(`fee_breakdown.${k} must be a number or null`);
  }
  return e;
}

export function validateDoc(doc) {
  const e = [];
  if (!doc || typeof doc !== "object") return ["document must be an object"];
  if (doc.schema_version !== SCHEMA_VERSION) e.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isMint(doc.wallet)) e.push("wallet must be a base58 address");
  if (typeof doc.updated_aest !== "string" || !ISO_AEST.test(doc.updated_aest)) e.push("updated_aest must be ISO +10:00");
  if (!Array.isArray(doc.trades)) return [...e, "trades must be an array"];
  const ids = new Set(), txs = new Set();
  doc.trades.forEach((t, i) => {
    for (const m of validateTrade(t)) e.push(`trades[${i}] (${t && t.id}): ${m}`);
    if (t && ids.has(t.id)) e.push(`trades[${i}]: duplicate id ${t.id}`);
    for (const s of t ? [t.tx, ...(Array.isArray(t.linked_txs) ? t.linked_txs : [])] : []) {
      if (txs.has(s)) e.push(`trades[${i}]: duplicate tx ${s}`);
      txs.add(s);
    }
    if (t) ids.add(t.id);
  });
  for (let i = 1; i < doc.trades.length; i++) {
    if (Date.parse(doc.trades[i].time_aest) < Date.parse(doc.trades[i - 1].time_aest)) { e.push("trades must be sorted by time_aest ascending"); break; }
  }
  return e;
}

// Stable sort by time, then by tx for ties.
export function sortTrades(trades) {
  return [...trades].sort((a, b) => Date.parse(a.time_aest) - Date.parse(b.time_aest) || (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0));
}

// Every signature a row accounts for (its tx plus linked_txs).
export function rowTxs(t) { return t ? [t.tx, ...(Array.isArray(t.linked_txs) ? t.linked_txs : [])] : []; }
export function loggedTxSet(trades) { return new Set((trades || []).flatMap(rowTxs)); }
