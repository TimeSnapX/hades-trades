#!/usr/bin/env node
// Hades Trades: add / validate rows in trades.json (schema v1, docs/SCHEMA.md).
//
//   node add-trade.mjs --from-tx <sig> [--reason "..."] [--exit-reason stop] \
//        [--snapshot '{"liquidity_usd":120000,...}'] [--targets real|'{...}'] [--json '{overrides}']
//   node add-trade.mjs --json '<full row>' [--verify]
//   node add-trade.mjs --validate
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

Row options (with --from-tx):
  --token SYM            token symbol (required for a new mint)
  --reason "..."         why the trade was made
  --run test|real        default: by time (real from 2026-10-06 21:12 AEST)
  --exit-reason R        SELL: target_1.5x target_2x target_other trail stop time_stop emergency rug manual rebalance
  --snapshot '{...}'     BUY: {liquidity_usd, volume24h_usd, age_hours, top10_pct, rugcheck_score,
                         filters_passed:[..], filters_failed:[..]} (unknown numbers: null)
  --targets real|'{...}' BUY: planned targets (real = 1/3 @1.5x, 1/3 @2x, trail 25%, stop -35%)
  --price-expected N     quoted SOL per token (enables slippage)
  --json '{...}'         extra overrides (must agree with chain values)
Common:
  --file <path>          default /home/box/hades/trades.json (or env HADES_TRADES)
  --dry-run              print the row, write nothing
  --replace              replace the row with the same tx (keeps its human fields unless given)
  --rpc <url>            extra RPC to try first; --offline --tx-json <file> for tests
Exit codes: 0 ok, 1 error/invalid, 3 duplicate tx (already logged).
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
    return p ? p.baseToken.symbol : null;
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
export async function rowFromTx(sig, overrides = {}, { wallet = WALLET, offline = false, txJson = null, rpcUrls } = {}) {
  const tx = txJson || (await getTx(sig, rpcUrls ? { urls: rpcUrls } : undefined));
  const d = P.parseTx(tx, wallet);
  if (!d.ok) throw new Error(`transaction ${sig} failed on chain; not logging it`);
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
    planned_targets: d.action === "BUY" && run === "real" ? REAL_TARGETS : null,
    token_program: trade ? d.token_program : null,
    verified_chain: true,
    unverified,
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
      const age = Date.now() - fs.statSync(lock).mtimeMs;
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
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown argument ${k} (see --help)`);
    }
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = a.file || process.env.HADES_TRADES || DEFAULT_FILE;
  if (a.help || (!a.fromTx && !a.json && !a.validate)) {
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
  let row;
  const overrides = a.json ? JSON.parse(a.json) : {};
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
      for (const k of ["token", "reason", "run", "entry_snapshot", "exit_reason", "planned_targets", "price_expected"]) if (existing[k] != null) keep[k] = existing[k];
      Object.assign(overrides, deepMerge(keep, overrides));
    }
    const txJson = a.txJson ? JSON.parse(fs.readFileSync(a.txJson, "utf8")) : null;
    row = await rowFromTx(a.fromTx, overrides, { wallet: doc.wallet, offline: a.offline, txJson: txJson && (txJson.result || txJson), rpcUrls: a.rpc });
  } else {
    row = overrides;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
