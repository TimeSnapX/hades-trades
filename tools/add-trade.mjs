#!/usr/bin/env node
// Hades Trades: add / validate rows in trades.json (schema v1, docs/SCHEMA.md).
//
//   node add-trade.mjs --from-tx <sig> [--reason "..."] [--exit-reason stop] \
//        [--snapshot '{"liquidity_usd":120000,...}'] [--targets real|'{...}'] [--json '{overrides}']
//   node add-trade.mjs --json '<full row>' [--verify]
//   node add-trade.mjs --validate
//   node add-trade.mjs --sync-unlogged [--dry-run]      wallet swaps not in the file -> trader "human" (inferred)
//   node add-trade.mjs --apply-overrides <file.json>    merge the app's "Mark as Me / Agent" export
//   node add-trade.mjs --backfill-trader                 set trader on rows that have none
// Common: --file <trades.json> (default /home/box/hades/trades.json), --dry-run,
//         --replace (overwrite the row with the same tx), --rpc <url>, --offline.
// Writes atomically (tmp file + rename, .bak kept, lock file) and keeps rows sorted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
async function load(name) {
  for (const p of [path.join(here, "lib", name), path.join(here, "..", "js", name)]) {
    if (fs.existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error(`cannot find ${name} next to add-trade.mjs (lib/) or in ../js/`);
}
const S = await load("schema.js");
const P = await load("parse-tx.js");

const HELP = `Hades Trades: add / validate rows in trades.json (schema v1, see SCHEMA.md).

Usage:
  node add-trade.mjs --from-tx <sig> [options]   fill a row from the chain (preferred)
  node add-trade.mjs --json '<full row>' [--verify]
  node add-trade.mjs --validate                   check the whole file
  node add-trade.mjs --sync-unlogged [--dry-run] [--reason "..."] [--since ISO]
                                                  add every on-chain wallet tx missing from the file
                                                  as trader "human", trader_source "inferred"
  node add-trade.mjs --apply-overrides <file>     merge the app's exported "Mark as Me / Agent"
                                                  overrides (trader_source "manual_override")
  node add-trade.mjs --backfill-trader            give rows without trader the default
                                                  (BUY/SELL agent, DEPOSIT/WITHDRAW human)

Row options (with --from-tx):
  --token SYM            token symbol (required for a new mint)
  --reason "..."         why the trade was made
  --run test|real        default: by time (real from 2026-10-06 21:12 AEST)
  --exit-reason R        SELL: target_1.5x target_2x target_other trail stop time_stop emergency rug manual rebalance
  --snapshot '{...}'     BUY: {liquidity_usd, volume24h_usd, age_hours, top10_pct, rugcheck_score,
                         filters_passed:[..], filters_failed:[..]} (unknown numbers: null)
  --targets real|'{...}' BUY: planned targets (real = 1/3 @1.5x, 1/3 @2x, trail 25%, stop -35%)
  --price-expected N     quoted SOL per token (enables slippage)
  --trader agent|human   who executed the trade (default: agent for BUY/SELL, human for
                         DEPOSIT/WITHDRAW). agent = Hades placed it, incl. on the user's
                         pick or instruction; human = the user traded himself in Phantom.
                         See LOGGING-RULES.md.
  --json '{...}'         extra overrides (must agree with chain values)
  --sol-usd N            SOL/USD to value stablecoin sell proceeds when Kraken is unavailable
Phantom sponsored sells (token out, stablecoin proceeds paid to another account,
gas lent by a sponsor) are logged as one SELL row with linked_txs; give the
token-out tx to --from-tx and the loan txs are found on chain.
Common:
  --file <path>          default /home/box/hades/trades.json (or env HADES_TRADES)
  --dry-run              print the row, write nothing
  --replace              replace the row with the same tx (keeps its human fields unless given)
  --rpc <url>            extra RPC to try first; --offline --tx-json <file> for tests
Exit codes: 0 ok, 1 error/invalid, 2 --sync-unlogged skipped some txs, 3 duplicate tx (already logged).
Writes atomically (tmp file + rename, .bak kept, lock file) and keeps rows sorted.`;

export const DEFAULT_FILE = "/home/box/hades/trades.json";
export const WALLET = "CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f";
export const REAL_RUN_START = "2026-10-06T21:12:00+10:00";
export const RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
export const REAL_TARGETS = {
  rule_set: "real-run-v1",
  take_profit: [{ x: 1.5, sell_frac: 1 / 3 }, { x: 2, sell_frac: 1 / 3 }],
  trail_pct: 25,
  stop_x: 0.65,
  time_stop_hours: 6,
  keep_min_frac: 0,
  note: "Sell 1/3 at 1.5x, 1/3 at 2x, trail final 1/3 at 25% from peak; hard stop -35%; time stop if not +20% within 6 h.",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rpc(method, params, { urls = RPCS, tries = 3 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        if (res.status === 429) { last = new Error(`${url}: 429 rate limited`); continue; }
        const j = await res.json();
        if (j.error) { last = new Error(`${url}: ${j.error.message}`); if (j.error.code === 429) continue; continue; }
        return j.result;
      } catch (err) { last = err; }
    }
    await sleep(800 * (attempt + 1));
  }
  throw last || new Error("rpc failed");
}

export async function getTx(sig, opts) {
  for (let i = 0; i < 4; i++) {
    const tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], opts);
    if (tx) return tx;
    await sleep(1500);
  }
  throw new Error(`transaction ${sig} not found (not confirmed yet?)`);
}

// SOL/USD close of the Kraken candle containing `unix` (1m, then 5m, 15m, 60m).
// Kraken returns the latest 720 candles per interval; results are cached per run.
const krakenCache = new Map();
async function krakenOhlc(interval) {
  if (krakenCache.has(interval)) return krakenCache.get(interval);
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=${interval}`);
      const j = await res.json();
      const rows = j.result && (j.result.SOLUSD || Object.values(j.result).find(Array.isArray));
      if (rows && rows.length) { krakenCache.set(interval, rows); return rows; }
    } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}
export async function solUsdAt(unix) {
  for (const interval of [1, 5, 15, 60]) {
    const rows = await krakenOhlc(interval);
    if (!rows) continue;
    const c = rows.find((r) => r[0] <= unix && unix < r[0] + interval * 60);
    if (c) return { price: Number(c[4]), source: `kraken SOLUSD ${interval}m close @ ${P.toAest(c[0])}` };
  }
  return null;
}

export async function tokenSymbol(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    const j = await res.json();
    const p = Array.isArray(j) ? j.find((x) => x.baseToken && x.baseToken.address === mint) : null;
    if (p) return p.baseToken.symbol;
  } catch { /* fall through to Jupiter */ }
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
    const j = await res.json();
    const t = Array.isArray(j) ? j.find((x) => x.id === mint) : null;
    return t && t.symbol ? t.symbol : null;
  } catch { return null; }
}

function deepMerge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== "object" || Array.isArray(b) || a === null || typeof a !== "object" || Array.isArray(a)) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

export function finishSnapshot(snap) {
  const s = deepMerge(S.emptySnapshot(), snap || {});
  const bad = S.validateSnapshot(s);
  if (bad.length) throw new Error("entry_snapshot is invalid:\n  " + bad.join("\n  "));
  const auto = S.autoFilters(s);
  const passed = new Set(s.filters_passed), failed = new Set(s.filters_failed);
  for (const f of auto.pass) if (!failed.has(f)) passed.add(f);
  for (const f of auto.fail) { failed.add(f); passed.delete(f); }
  s.filters_passed = Object.keys(S.FILTERS).filter((f) => passed.has(f));
  s.filters_failed = Object.keys(S.FILTERS).filter((f) => failed.has(f));
  return s;
}

export function makeId(row) {
  return `${row.action.toLowerCase()}-${(row.token || "sol").toLowerCase().replace(/[^a-z0-9]+/g, "")}-${row.tx.slice(0, 8)}`;
}

// Build a schema row from a parsed chain draft plus overrides.
// Signatures of the wallet within +-windowSec of a tx (to find sponsored-sell loans).
export async function nearbySigs(wallet, sig, unix, { windowSec = 120, rpcUrls } = {}) {
  const o = rpcUrls ? { urls: rpcUrls } : undefined;
  const older = (await rpc("getSignaturesForAddress", [wallet, { before: sig, limit: 15 }], o)) || [];
  const newer = (await rpc("getSignaturesForAddress", [wallet, { until: sig, limit: 1000 }], o)) || [];
  return [...older, ...newer].filter((s) => !s.err && s.blockTime && Math.abs(s.blockTime - unix) <= windowSec).map((s) => s.signature);
}

export function defaultTrader(action, given) {
  if (given) return { trader: given, trader_source: "logged" };
  return action === "DEPOSIT" || action === "WITHDRAW" ? { trader: "human", trader_source: "inferred" } : { trader: "agent", trader_source: "logged" };
}

export async function rowFromTx(sig, overrides = {}, { wallet = WALLET, offline = false, txJson = null, rpcUrls, linkedTxJson = null, solUsd = null, draft = null, others = null } = {}) {
  const d = draft || P.parseTx(txJson || (await getTx(sig, rpcUrls ? { urls: rpcUrls } : undefined)), wallet);
  if (!d.ok) throw new Error(`transaction ${sig} failed on chain; not logging it`);
  if (!d.action && d.kind === "TOKEN_OUT" && d.external_proceeds) {
    let drafts = others;
    if (!drafts) {
      if (linkedTxJson) drafts = linkedTxJson.map((j) => P.parseTx(j, wallet));
      else if (offline) drafts = [];
      else {
        drafts = [];
        for (const s of await nearbySigs(wallet, d.tx, d.time_unix, { rpcUrls })) if (s !== d.tx) drafts.push(P.parseTx(await getTx(s, rpcUrls ? { urls: rpcUrls } : undefined), wallet));
      }
    }
    return sponsoredRow(d, drafts, overrides, { wallet, offline, solUsd });
  }
  if (!d.action) throw new Error(`cannot classify ${sig} (kind ${d.kind}); add it manually with --json`);
  const unverified = [...d.unverified];
  let token = overrides.token || null;
  if (!token && d.mint && !offline) token = await tokenSymbol(d.mint);
  if (!token && d.mint) unverified.push("token");
  let usd = null, usd_source = null;
  if (!offline) {
    const px = await solUsdAt(d.time_unix);
    if (px) { usd = P.round(d.sol * px.price, 4); usd_source = px.source; }
  }
  if (usd == null) unverified.push("usd_at_time");
  const trade = d.action === "BUY" || d.action === "SELL";
  const run = overrides.run || (Date.parse(d.time_aest) >= Date.parse(REAL_RUN_START) ? "real" : "test");
  const who = defaultTrader(d.action, overrides.trader);
  if (overrides.trader_source) who.trader_source = overrides.trader_source;
  let row = {
    id: null,
    time_aest: d.time_aest,
    action: d.action,
    token: trade ? token : "SOL",
    mint: trade ? d.mint : null,
    sol: d.sol,
    tokens: trade ? d.tokens : null,
    usd_at_time: usd,
    usd_source,
    fee_sol: d.fee_sol,
    fee_breakdown: d.fee_breakdown,
    rent_sol: d.rent_sol,
    price_expected: null,
    price_filled: d.price_filled,
    tx: d.tx,
    reason: null,
    run,
    entry_snapshot: d.action === "BUY" ? S.emptySnapshot() : null,
    exit_reason: null,
    planned_targets: d.action === "BUY" && run === "real" && who.trader === "agent" ? REAL_TARGETS : null,
    token_program: trade ? d.token_program : null,
    verified_chain: true,
    unverified,
    trader: who.trader,
    trader_source: who.trader_source,
  };
  if (overrides.planned_targets === "real") overrides = { ...overrides, planned_targets: REAL_TARGETS };
  const chainFields = ["time_aest", "action", "mint", "sol", "tokens", "fee_sol", "fee_breakdown", "rent_sol", "price_filled", "tx"];
  for (const k of chainFields) if (k in overrides && JSON.stringify(overrides[k]) !== JSON.stringify(row[k])) {
    throw new Error(`override of chain field "${k}" (${JSON.stringify(overrides[k])}) disagrees with chain (${JSON.stringify(row[k])})`);
  }
  row = deepMerge(row, overrides);
  if (row.action === "BUY") row.entry_snapshot = finishSnapshot(row.entry_snapshot);
  if (row.reason == null && !row.unverified.includes("reason")) row.unverified.push("reason");
  if (row.action === "BUY" && row.price_expected == null) row.unverified.push("price_expected");
  if (row.action === "SELL" && row.price_expected == null) row.unverified.push("price_expected");
  row.unverified = [...new Set(row.unverified)];
  if (!row.id) row.id = makeId(row);
  return row;
}

// One SELL row for a Phantom sponsored sell (see SCHEMA.md, proceeds_external).
export async function sponsoredRow(main, others, overrides = {}, { wallet = WALLET, offline = false, solUsd = null } = {}) {
  const [bundle] = P.findSponsoredSells([main, ...others], { wallet }).filter((b) => b.main.tx === main.tx);
  if (!bundle) throw new Error(`cannot build a sponsored sell for ${main.tx}`);
  if (!bundle.loanIn !== !bundle.loanOut) throw new Error(`sponsored sell ${main.tx}: found only one of the loan txs; not logging a partial bundle`);
  let px = solUsd != null ? { price: solUsd, source: "given (--sol-usd)" } : null;
  if (!px && !offline) px = await solUsdAt(main.time_unix);
  if (!px) throw new Error(`sponsored sell ${main.tx}: SOL/USD at the time is needed to value the ${main.external_proceeds.asset} proceeds (pass --sol-usd N)`);
  const f = P.sponsoredSellFields(bundle, px.price);
  if (!(f.sol > 0)) throw new Error(`sponsored sell ${main.tx}: non-positive value (${f.sol})`);
  let token = overrides.token || null;
  if (!token && !offline) token = await tokenSymbol(main.mint);
  const unverified = ["price_expected", "platform_fee_sol"];
  if (!token) unverified.push("token");
  if (overrides.reason == null) unverified.push("reason");
  const run = overrides.run || (Date.parse(main.time_aest) >= Date.parse(REAL_RUN_START) ? "real" : "test");
  const who = defaultTrader("SELL", overrides.trader);
  if (overrides.trader_source) who.trader_source = overrides.trader_source;
  const row = {
    id: null, time_aest: f.time_aest, action: "SELL", token, mint: f.mint, sol: f.sol, tokens: f.tokens,
    usd_at_time: P.round(f.sol * px.price, 4), usd_source: px.source,
    fee_sol: f.fee_sol, fee_breakdown: f.fee_breakdown, rent_sol: f.rent_sol,
    price_expected: null, price_filled: f.price_filled, tx: f.tx,
    reason: overrides.reason != null ? overrides.reason : null, run,
    entry_snapshot: null, exit_reason: overrides.exit_reason || null, planned_targets: null,
    token_program: f.token_program, verified_chain: true, unverified,
    trader: who.trader, trader_source: who.trader_source,
    linked_txs: f.linked_txs, wallet_sol_delta: f.wallet_sol_delta,
    proceeds_external: { ...f.proceeds_external, sol_equiv_source: `${f.proceeds_external.asset} taken as 1 USD; SOL/USD ${px.source}` },
  };
  row.id = makeId(row);
  return row;
}

// Compare a hand-entered row with the chain; returns list of mismatches.
export function compareWithChain(row, draft) {
  const bad = [];
  const close = (a, b, rel = 0.005) => a != null && b != null && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * rel);
  if (row.action !== draft.action) bad.push(`action ${row.action} vs chain ${draft.action}`);
  if (row.mint && row.mint !== draft.mint) bad.push(`mint ${row.mint} vs chain ${draft.mint}`);
  if (!close(row.sol, draft.sol)) bad.push(`sol ${row.sol} vs chain ${draft.sol}`);
  if (row.tokens != null && !close(row.tokens, draft.tokens)) bad.push(`tokens ${row.tokens} vs chain ${draft.tokens}`);
  return bad;
}

export function readDoc(file) {
  if (!fs.existsSync(file)) {
    return { schema_version: S.SCHEMA_VERSION, wallet: WALLET, gmgn: `https://gmgn.ai/sol/address/${WALLET}`, real_run_start_aest: REAL_RUN_START, updated_aest: P.toAest(Math.floor(Date.now() / 1000)), trades: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeDocAtomic(file, doc) {
  const errs = S.validateDoc(doc);
  if (errs.length) throw new Error("refusing to write invalid document:\n  " + errs.join("\n  "));
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, JSON.stringify(doc, null, 2) + "\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  fs.renameSync(tmp, file);
}

function withLock(file, fn) {
  const lock = file + ".lock";
  let fd;
  for (let i = 0; i < 50; i++) {
    try { fd = fs.openSync(lock, "wx"); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; } // released meanwhile
      if (age > 60000) { fs.rmSync(lock, { force: true }); continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  if (fd === undefined) throw new Error(`could not lock ${lock}`);
  try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

export function upsert(doc, row, { replace = false } = {}) {
  const errs = S.validateTrade(row);
  if (errs.length) throw new Error("row is invalid:\n  " + errs.join("\n  "));
  const i = doc.trades.findIndex((t) => t.tx === row.tx);
  if (i >= 0 && !replace) return { doc, added: false, reason: `tx already logged as ${doc.trades[i].id} (use --replace to overwrite)` };
  const mine = new Set(S.rowTxs(row));
  const clash = doc.trades.find((t, j) => j !== i && S.rowTxs(t).some((x) => mine.has(x)));
  if (clash) return { doc, added: false, reason: `a tx of this row is already logged in ${clash.id}` };
  const trades = i >= 0 ? doc.trades.map((t, j) => (j === i ? row : t)) : [...doc.trades, row];
  if (trades.some((t, j) => t.id === row.id && t.tx !== row.tx)) throw new Error(`id ${row.id} already used by another tx`);
  const out = { ...doc, trades: S.sortTrades(trades), updated_aest: P.toAest(Math.floor(Date.now() / 1000)) };
  return { doc: out, added: true, replaced: i >= 0 };
}

function parseArgs(argv) {
  const a = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    switch (k) {
      case "--file": a.file = next(); break;
      case "--from-tx": a.fromTx = next(); break;
      case "--json": a.json = next(); break;
      case "--json-file": a.json = fs.readFileSync(next(), "utf8"); break;
      case "--reason": a.reason = next(); break;
      case "--token": a.token = next(); break;
      case "--run": a.run = next(); break;
      case "--exit-reason": a.exitReason = next(); break;
      case "--snapshot": a.snapshot = next(); break;
      case "--targets": a.targets = next(); break;
      case "--price-expected": a.priceExpected = Number(next()); break;
      case "--rpc": a.rpc = next().split(","); break;
      case "--tx-json": a.txJson = next(); break;
      case "--replace": a.replace = true; break;
      case "--dry-run": a.dry = true; break;
      case "--verify": a.verify = true; break;
      case "--offline": a.offline = true; break;
      case "--validate": a.validate = true; break;
      case "--trader": a.trader = next(); if (!["agent", "human"].includes(a.trader)) throw new Error("--trader must be agent or human"); break;
      case "--sync-unlogged": a.sync = true; break;
      case "--since": a.since = next(); break;
      case "--apply-overrides": a.applyOverrides = next(); break;
      case "--backfill-trader": a.backfill = true; break;
      case "--sol-usd": a.solUsd = Number(next()); break;
      case "--linked-tx-json": a.linkedTxJson = next().split(","); break;
      case "--sigs-json": a.sigsJson = next(); break;
      case "--tx-dir": a.txDir = next(); break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown argument ${k} (see --help)`);
    }
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = a.file || process.env.HADES_TRADES || DEFAULT_FILE;
  if (a.help || (!a.fromTx && !a.json && !a.validate && !a.sync && !a.applyOverrides && !a.backfill)) {
    console.log(HELP);
    return;
  }
  const doc = readDoc(file);
  if (a.validate) {
    const errs = S.validateDoc(doc);
    if (errs.length) { console.error(`INVALID ${file}:\n  ` + errs.join("\n  ")); process.exit(1); }
    console.log(`OK ${file}: ${doc.trades.length} rows, schema v${doc.schema_version}`);
    return;
  }
  if (a.backfill) return backfillMain(file, a);
  if (a.applyOverrides) return applyOverridesMain(file, a);
  if (a.sync) return syncMain(file, doc, a);
  let row;
  const overrides = a.json ? JSON.parse(a.json) : {};
  if (a.trader) overrides.trader = a.trader;
  if (a.reason != null) overrides.reason = a.reason;
  if (a.token) overrides.token = a.token;
  if (a.run) overrides.run = a.run;
  if (a.exitReason) overrides.exit_reason = a.exitReason;
  if (a.snapshot) overrides.entry_snapshot = JSON.parse(a.snapshot);
  if (a.targets) overrides.planned_targets = a.targets === "real" ? "real" : JSON.parse(a.targets);
  if (a.priceExpected != null) overrides.price_expected = a.priceExpected;
  if (a.fromTx) {
    if (!S.isSig(a.fromTx)) throw new Error("--from-tx needs a transaction signature");
    const existing = doc.trades.find((t) => t.tx === a.fromTx);
    if (existing && a.replace) {
      // keep the human-entered fields of the row being replaced unless overridden
      const keep = {};
      for (const k of ["token", "reason", "run", "entry_snapshot", "exit_reason", "planned_targets", "price_expected", "trader", "trader_source"]) if (existing[k] != null) keep[k] = existing[k];
      if (a.trader) delete keep.trader_source;
      Object.assign(overrides, deepMerge(keep, overrides));
    }
    const txJson = a.txJson ? JSON.parse(fs.readFileSync(a.txJson, "utf8")) : null;
    const linked = a.linkedTxJson ? a.linkedTxJson.map((f) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); return j.result || j; }) : null;
    row = await rowFromTx(a.fromTx, overrides, { wallet: doc.wallet, offline: a.offline, txJson: txJson && (txJson.result || txJson), rpcUrls: a.rpc, linkedTxJson: linked, solUsd: a.solUsd });
  } else {
    row = overrides;
    if (row.action && !row.trader) Object.assign(row, defaultTrader(row.action, null));
    if (row.action === "BUY") row.entry_snapshot = finishSnapshot(row.entry_snapshot);
    if (!row.id && row.action && row.tx) row.id = makeId(row);
    if (a.verify) {
      const d = P.parseTx(await getTx(row.tx, a.rpc ? { urls: a.rpc } : undefined), doc.wallet);
      const bad = compareWithChain(row, d);
      if (bad.length) throw new Error("row disagrees with chain:\n  " + bad.join("\n  "));
      row.verified_chain = true;
    }
  }
  const res = withLock(file, () => {
    const fresh = readDoc(file);
    const r = upsert(fresh, row, { replace: a.replace });
    if (r.added && !a.dry) writeDocAtomic(file, r.doc);
    return r;
  });
  if (!res.added) { console.log(`SKIPPED (duplicate): ${res.reason}`); process.exitCode = 3; return; }
  console.log(JSON.stringify(row, null, 2));
  console.log(`${a.dry ? "DRY RUN, not written" : res.replaced ? "REPLACED in" : "ADDED to"} ${file} (${res.doc.trades.length} rows)`);
  if (row.unverified && row.unverified.length) console.log(`unverified fields: ${row.unverified.join(", ")}`);
}

function writeAll(file, mutate, dry) {
  return withLock(file, () => {
    const fresh = readDoc(file);
    const r = mutate(fresh);
    if (r.changed && !dry) writeDocAtomic(file, { ...r.doc, updated_aest: P.toAest(Math.floor(Date.now() / 1000)) });
    return r;
  });
}

function backfillMain(file, a) {
  const r = writeAll(file, (doc) => {
    let n = 0;
    const trades = doc.trades.map((t) => { if (t.trader) return t; n++; return { ...t, ...defaultTrader(t.action, null) }; });
    return { doc: { ...doc, trades }, changed: n > 0, n };
  }, a.dry);
  console.log(`${a.dry ? "DRY RUN: would set" : "set"} trader on ${r.n} row(s) in ${file}`);
}

// Accepts the app export {overrides:[{tx, trader}]} or a plain {tx: trader} map.
function applyOverridesMain(file, a) {
  const j = JSON.parse(fs.readFileSync(a.applyOverrides, "utf8"));
  const list = Array.isArray(j.overrides) ? j.overrides : Object.entries(j.overrides || j).map(([tx, trader]) => ({ tx, trader }));
  for (const o of list) if (!S.isSig(o.tx) || !["agent", "human"].includes(o.trader)) throw new Error(`bad override ${JSON.stringify(o)}`);
  const r = writeAll(file, (doc) => {
    const by = new Map(list.map((o) => [o.tx, o.trader]));
    const seen = new Set(), changes = [];
    const trades = doc.trades.map((t) => {
      if (!by.has(t.tx)) return t;
      seen.add(t.tx);
      const trader = by.get(t.tx);
      if (t.trader === trader && t.trader_source === "manual_override") return t;
      changes.push(`${t.id}: ${t.trader || "(none)"} -> ${trader}`);
      return { ...t, trader, trader_source: "manual_override" };
    });
    return { doc: { ...doc, trades }, changed: changes.length > 0, changes, unknown: list.filter((o) => !seen.has(o.tx)).map((o) => o.tx) };
  }, a.dry);
  for (const c of r.changes) console.log("  " + c);
  if (r.unknown.length) console.log(`not in the file (log them first): ${r.unknown.join(", ")}`);
  console.log(`${a.dry ? "DRY RUN: would apply" : "applied"} ${r.changes.length} override(s) to ${file}`);
}

async function allWalletSigs(wallet, rpcUrls) {
  const out = [];
  let before;
  for (let i = 0; i < 10; i++) {
    const page = await rpc("getSignaturesForAddress", [wallet, { limit: 1000, ...(before ? { before } : {}) }], rpcUrls ? { urls: rpcUrls } : undefined);
    if (!page || !page.length) break;
    out.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out;
}

// Pull every wallet tx not in the file and add it as trader "human" (inferred):
// on-chain activity Hades did not log is the user trading by hand in Phantom.
async function syncMain(file, doc, a) {
  const wallet = doc.wallet;
  const logged = S.loggedTxSet(doc.trades);
  const first = doc.trades.length ? Date.parse(doc.trades[0].time_aest) / 1000 : 0;
  const since = a.since ? Date.parse(a.since) / 1000 : first - 60;
  const sigs = a.sigsJson ? JSON.parse(fs.readFileSync(a.sigsJson, "utf8")) : await allWalletSigs(wallet, a.rpc);
  const todo = sigs.filter((s) => !s.err && !logged.has(s.signature) && (!s.blockTime || s.blockTime >= since)).map((s) => s.signature);
  console.log(`${sigs.length} wallet signatures, ${todo.length} not in ${file}`);
  if (!todo.length) return;
  const txDir = a.txDir || null; // tests: directory of <sig>.json
  const drafts = [];
  for (const sig of todo) {
    try {
      const tx = txDir ? JSON.parse(fs.readFileSync(path.join(txDir, `${sig}.json`), "utf8")) : await getTx(sig, a.rpc ? { urls: a.rpc } : undefined);
      drafts.push(P.parseTx(tx.result || tx, wallet));
    } catch (e) { console.log(`  skip ${sig.slice(0, 12)}: ${e.message}`); }
  }
  const bundles = P.findSponsoredSells(drafts, { wallet });
  const inBundle = new Set(bundles.flatMap((b) => [b.main, b.loanIn, b.loanOut].filter(Boolean).map((d) => d.tx)));
  const base = { reason: a.reason != null ? a.reason : "manual (user)", trader: a.trader || "human", trader_source: a.trader ? "logged" : "inferred" };
  if (a.run) base.run = a.run;
  const rows = [], skipped = [];
  const symbols = new Map();
  const sym = async (mint) => { if (!mint) return null; if (!symbols.has(mint)) symbols.set(mint, a.offline ? null : await tokenSymbol(mint)); return symbols.get(mint); };
  for (const b of bundles) {
    try { rows.push(await sponsoredRow(b.main, drafts.filter((d) => d !== b.main), { ...base, token: (await sym(b.main.mint)) || undefined, exit_reason: "manual" }, { wallet, offline: a.offline, solUsd: a.solUsd })); }
    catch (e) { skipped.push(`${b.main.tx.slice(0, 12)} ${e.message}`); }
  }
  for (const d of drafts) {
    if (inBundle.has(d.tx)) continue;
    if (!d.ok) { skipped.push(`${d.tx.slice(0, 12)} failed on chain`); continue; }
    if (!d.action) { skipped.push(`${d.tx.slice(0, 12)} ${d.kind}: cannot classify (add by hand with --json)`); continue; }
    const o = { ...base };
    if (d.action === "SELL") o.exit_reason = "manual";
    const s = await sym(d.mint); if (s) o.token = s;
    if (d.action === "BUY") o.entry_snapshot = { source: "inferred: unlogged on-chain trade (manual, Phantom)" };
    try { rows.push(await rowFromTx(d.tx, o, { wallet, offline: a.offline, draft: d })); } catch (e) { skipped.push(`${d.tx.slice(0, 12)} ${e.message}`); }
  }
  for (const r of rows) if (r.token == null) { r.token = r.mint ? r.mint.slice(0, 6) : "SOL"; r.id = makeId(r); }
  const res = writeAll(file, (fresh) => {
    let cur = fresh, added = [];
    for (const r of rows) { const u = upsert(cur, r); if (u.added) { cur = u.doc; added.push(r); } }
    return { doc: cur, changed: added.length > 0, added };
  }, a.dry);
  for (const r of res.added) console.log(`  + ${r.time_aest} ${r.action.padEnd(8)} ${String(r.token).padEnd(10)} ${r.sol} SOL${r.linked_txs ? ` (+${r.linked_txs.length} linked)` : ""} ${r.trader}/${r.trader_source} ${r.tx.slice(0, 10)}`);
  for (const k of skipped) console.log(`  ! ${k}`);
  console.log(`${a.dry ? "DRY RUN: would add" : "added"} ${res.added.length} row(s), skipped ${skipped.length}${a.dry ? "" : ` -> ${file}`}`);
  if (skipped.length) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
