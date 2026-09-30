// Hades Trades: keyless live data with fallbacks, caching and rate-limit handling.
// Read-only: only public GET/POST JSON-RPC reads. No wallet connection, no keys.
import { TOKEN_PROGRAMS, WSOL } from "./parse-tx.js";

// api.mainnet-beta.solana.com is not listed: it answers 403 to browser origins.
export const RPCS = ["https://solana-rpc.publicnode.com", "https://rpc.solanatracker.io/public"];
export const DEX = "https://api.dexscreener.com/tokens/v1/solana/";
export const JUP = "https://lite-api.jup.ag/ultra/v1/holdings/";
export const GT = "https://api.geckoterminal.com/api/v2/networks/solana/pools/";
const PREFIX = "ht:v1:";

export const status = {}; // source -> {ok, detail, stale, at}
const setStatus = (k, v) => { status[k] = { ...v, at: Date.now() }; };

export function cacheGet(key) {
  try { const raw = localStorage.getItem(PREFIX + key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function cacheSet(key, v) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v })); } catch { /* quota: ignore */ }
}

export class HttpError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function fetchJson(url, { method = "GET", body, timeout = 12000, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { method, body, headers: body ? { "content-type": "application/json", ...headers } : headers, signal: ctl.signal, cache: "no-store", credentials: "omit" });
    if (!res.ok) throw new HttpError(`${new URL(url).host} HTTP ${res.status}`, res.status);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new HttpError(`${new URL(url).host} timed out`, 0);
    if (e instanceof HttpError) throw e;
    throw new HttpError(`${new URL(url).host} unreachable`, 0);
  } finally { clearTimeout(timer); }
}

// Cached wrapper: fresh within ttl; on failure returns stale value flagged.
export async function cached(key, ttlMs, fn) {
  const c = cacheGet(key);
  if (c && Date.now() - c.t < ttlMs) return { v: c.v, t: c.t, fresh: true, cached: true };
  try {
    const v = await fn();
    cacheSet(key, v);
    return { v, t: Date.now(), fresh: true };
  } catch (e) {
    if (c) return { v: c.v, t: c.t, fresh: false, stale: true, error: e };
    throw e;
  }
}

const cooldown = new Map(); // rpc url -> until (rate limited)
// "url|method" pairs an endpoint refuses (e.g. indexed methods need a key). Remembered
// for 12 h so a refused call is retried at most twice a day (each refusal logs a
// browser console error we cannot suppress).
const unsupported = new Set((() => { const c = cacheGet("rpc-unsupported"); return c && Date.now() - c.t < 12 * 3600e3 ? c.v : []; })());
const markUnsupported = (k) => { unsupported.add(k); cacheSet("rpc-unsupported", [...unsupported]); };
export async function rpc(method, params) {
  const errors = [];
  const order = RPCS.filter((u) => !unsupported.has(`${u}|${method}`)).sort((a, b) => (cooldown.get(a) || 0) - (cooldown.get(b) || 0));
  for (const url of order) {
    const host = new URL(url).host;
    if ((cooldown.get(url) || 0) > Date.now() && url !== order[order.length - 1]) { errors.push(`${host} rate-limited`); continue; }
    try {
      const j = await fetchJson(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (j.error) {
        const m = String(j.error.message || "");
        if (j.error.code === 429 || /rate|too many/i.test(m)) cooldown.set(url, Date.now() + 30000);
        else if (j.error.code === 403 || j.error.code === -32601 || /token|not allowed|forbidden|paid/i.test(m)) markUnsupported(`${url}|${method}`);
        errors.push(`${host}: ${m}`);
        continue;
      }
      setStatus("rpc", { ok: true, detail: host });
      return j.result;
    } catch (e) {
      if (e.status === 429) cooldown.set(url, Date.now() + 30000);
      if (e.status === 403) markUnsupported(`${url}|${method}`);
      errors.push(e.message);
    }
  }
  const err = new Error(`${method}: all RPCs failed (${errors.join("; ") || "none support it"})`);
  throw err;
}

// Token balances: RPC getTokenAccountsByOwner (SPL + Token-2022), falling back
// to Jupiter's keyless holdings API when public RPCs refuse indexed calls.
async function tokenAccounts(wallet) {
  try {
    const accounts = [];
    for (const programId of TOKEN_PROGRAMS) {
      const res = await rpc("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const a of res.value) {
        const info = a.account.data.parsed.info;
        accounts.push({ address: a.pubkey, program: programId, mint: info.mint, amount: Number(info.tokenAmount.uiAmountString), decimals: info.tokenAmount.decimals, lamports: a.account.lamports });
      }
    }
    return { accounts, via: "RPC getTokenAccountsByOwner" };
  } catch (rpcErr) {
    try {
      const j = await fetchJson(`${JUP}${wallet}`);
      const accounts = [];
      for (const [mint, list] of Object.entries(j.tokens || {})) for (const a of list) {
        accounts.push({ address: a.account, program: a.programId, mint, amount: Number(a.uiAmountString != null ? a.uiAmountString : a.uiAmount), decimals: a.decimals, lamports: Number(a.lamports || 0) });
      }
      return { accounts, via: "Jupiter holdings API", sol: j.uiAmount != null ? Number(j.uiAmount) : null, note: rpcErr.message };
    } catch (jupErr) {
      throw new Error(`token balances unavailable: ${rpcErr.message}; Jupiter: ${jupErr.message}`);
    }
  }
}

export async function getWallet(wallet) {
  const r = await cached(`wallet:${wallet}`, 30000, async () => {
    const tok = await tokenAccounts(wallet);
    let sol;
    try { sol = (await rpc("getBalance", [wallet, { commitment: "confirmed" }])).value / 1e9; }
    catch (e) { if (tok.sol != null) sol = tok.sol; else throw e; }
    let sigs = null, sigError = null;
    try { sigs = (await rpc("getSignaturesForAddress", [wallet, { limit: 50 }])).map((s) => ({ sig: s.signature, t: s.blockTime, err: s.err != null })); }
    catch (e) { sigError = e.message; }
    return { sol, accounts: tok.accounts, tokens_via: tok.via, sigs, sig_error: sigError };
  });
  setStatus("rpc", r.stale
    ? { ok: false, stale: true, detail: `cached balances from ${new Date(r.t).toLocaleTimeString("en-AU", { timeZone: "Australia/Brisbane" })} (${r.error.message})` }
    : { ok: !r.v.sig_error, detail: `balances via ${r.v.tokens_via}${r.v.sig_error ? `; signatures failed: ${r.v.sig_error}` : ""}` });
  return r;
}

export async function getTx(sig) {
  const c = cacheGet(`tx:${sig}`);
  if (c) return c.v;
  const tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  return tx;
}

// Prices: DexScreener (best SOL-quoted pair per mint, also gives the pool for
// OHLCV); mints it cannot price fall back to Jupiter's keyless price API (USD,
// converted to SOL with Jupiter's own SOL price).
export const JUP_PRICE = "https://lite-api.jup.ag/price/v3?ids=";
async function dexPrices(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    const pairs = await fetchJson(DEX + chunk.join(","));
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const m = p.baseToken && p.baseToken.address;
      if (!chunk.includes(m)) continue;
      const solQuote = p.quoteToken && p.quoteToken.address === WSOL;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const cur = out[m];
      const better = !cur || (solQuote && !cur.sol_quote) || (solQuote === cur.sol_quote && liq > cur.liq_usd);
      if (better) out[m] = { mint: m, source: "DexScreener", symbol: p.baseToken.symbol, pair: p.pairAddress, dex: p.dexId, sol_quote: solQuote, price_native: Number(p.priceNative), price_usd: p.priceUsd != null ? Number(p.priceUsd) : null, liq_usd: liq, vol24_usd: p.volume && p.volume.h24, pair_created: p.pairCreatedAt || null, url: p.url };
    }
  }
  return out;
}
async function jupPrices(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 49) {
    const chunk = list.slice(i, i + 49);
    const j = await fetchJson(JUP_PRICE + [...chunk, WSOL].join(","));
    const sol = j[WSOL] && Number(j[WSOL].usdPrice);
    for (const m of chunk) {
      const r = j[m];
      if (!r || !(r.usdPrice > 0)) continue;
      out[m] = { mint: m, source: "Jupiter", symbol: null, pair: null, dex: "jupiter", sol_quote: false, price_usd: Number(r.usdPrice), price_sol: sol ? Number(r.usdPrice) / sol : null, sol_usd: sol || null, liq_usd: r.liquidity || null, created_at: r.createdAt || null };
    }
  }
  return out;
}
export async function getPrices(mints) {
  const list = [...new Set(mints)].filter(Boolean).sort();
  if (!list.length) return { v: {}, t: Date.now() };
  let dexErr = null, jupErr = null;
  const r = await cached(`px:${list.join(",")}`, 60000, async () => {
    let out = {};
    try { out = await dexPrices(list); } catch (e) { dexErr = e; }
    const missing = list.filter((m) => !out[m]);
    if (missing.length) { try { Object.assign(out, await jupPrices(missing)); } catch (e) { jupErr = e; } }
    if (!Object.keys(out).length && (dexErr || jupErr)) throw new Error([dexErr && `DexScreener: ${dexErr.message}`, jupErr && `Jupiter: ${jupErr.message}`].filter(Boolean).join("; "));
    return out;
  });
  const n = Object.keys(r.v).length, nj = Object.values(r.v).filter((x) => x.source === "Jupiter").length;
  if (r.stale) setStatus("dex", { ok: false, stale: true, detail: `cached prices (${r.error.message})` });
  else if (dexErr || nj) setStatus("dex", { ok: !dexErr, degraded: !!dexErr, detail: `${n}/${list.length} priced; ${nj} via Jupiter${dexErr ? ` (DexScreener failed: ${dexErr.message})` : ""}` });
  else setStatus("dex", { ok: true, detail: `${n}/${list.length} tokens priced (DexScreener)` });
  return r;
}

// SOL/USD and USD/AUD with fallbacks. `dexHint` = a SOL-quoted pair {price_usd, price_native}.
export async function getFx(dexHint) {
  const attempts = [];
  const tryOne = async (name, fn) => { try { const v = await fn(); if (v && v.sol_usd > 0 && v.usd_aud > 0) return { ...v, source: name }; attempts.push(`${name}: incomplete`); } catch (e) { attempts.push(`${name}: ${e.message}`); } return null; };
  try {
    const r = await cached("fx", 5 * 60000, async () => {
      const v = (await tryOne("Coinbase", async () => { const j = await fetchJson("https://api.coinbase.com/v2/exchange-rates?currency=SOL"); const usd = Number(j.data.rates.USD), aud = Number(j.data.rates.AUD); return { sol_usd: usd, usd_aud: aud / usd }; }))
        || (await tryOne("CoinGecko", async () => { const j = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,aud"); return { sol_usd: j.solana.usd, usd_aud: j.solana.aud / j.solana.usd }; }))
        || (await tryOne("Binance + ExchangeRate-API", async () => { const [b, e] = await Promise.all([fetchJson("https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT"), fetchJson("https://open.er-api.com/v6/latest/USD")]); return { sol_usd: Number(b.price), usd_aud: Number(e.rates.AUD) }; }));
      if (!v) throw new Error(attempts.join("; "));
      return v;
    });
    setStatus("fx", r.stale ? { ok: false, stale: true, detail: `cached rate (${r.error.message})` } : { ok: true, detail: r.v.source });
    return r;
  } catch (e) {
    if (dexHint && (dexHint.sol_usd || (dexHint.price_usd && dexHint.price_native))) {
      const v = { sol_usd: dexHint.sol_usd || dexHint.price_usd / dexHint.price_native, usd_aud: null, source: `${dexHint.source || "DexScreener"} implied (no AUD)` };
      setStatus("fx", { ok: false, detail: `SOL/USD implied from DexScreener; AUD unavailable (${e.message})` });
      return { v, t: Date.now(), fresh: true };
    }
    setStatus("fx", { ok: false, detail: e.message });
    throw e;
  }
}

// GeckoTerminal OHLCV in SOL per token (currency=token, token=<mint>).
export function timeframeFor(spanMs) {
  const h = spanMs / 3600e3;
  if (h <= 80) return { tf: "minute", agg: 5, step: 300e3 };
  if (h <= 240) return { tf: "minute", agg: 15, step: 900e3 };
  if (h <= 950) return { tf: "hour", agg: 1, step: 3600e3 };
  return { tf: "day", agg: 1, step: 86400e3 };
}
let gtCooldownUntil = 0;
export const gtCooling = () => gtCooldownUntil > Date.now();
export async function getCandles(pool, mint, fromMs, toMs) {
  const { tf, agg, step } = timeframeFor(toMs - fromMs);
  const key = `ohlcv:${pool}:${mint}:${tf}${agg}:${Math.floor(fromMs / step)}`;
  const r = await cached(key, 10 * 60000, async () => {
    const all = [];
    let before = Math.ceil(toMs / 1000);
    for (let page = 0; page < 4; page++) {
      if (gtCooling()) throw new Error("GeckoTerminal rate-limited; retrying later");
      let j;
      try { j = await fetchJson(`${GT}${pool}/ohlcv/${tf}?aggregate=${agg}&limit=1000&currency=token&token=${mint}&before_timestamp=${before}`); }
      catch (e) { if (e.status === 429 || e.status === 0) gtCooldownUntil = Date.now() + 90000; throw e; }
      const list = (j.data && j.data.attributes && j.data.attributes.ohlcv_list) || [];
      if (!list.length) break;
      for (const [t, o, h, l, c] of list) all.push({ t: t * 1000, o: +o, h: +h, l: +l, c: +c });
      const oldest = Math.min(...list.map((x) => x[0]));
      if (oldest * 1000 <= fromMs || list.length < 1000) break;
      before = oldest;
    }
    const uniq = new Map(all.map((c) => [c.t, c]));
    return [...uniq.values()].sort((a, b) => a.t - b.t);
  });
  return r;
}

// Pool address for OHLCV: remembered from DexScreener; else GeckoTerminal's token pools.
export async function getPool(mint, fromDex) {
  if (fromDex) { cacheSet(`pool:${mint}`, fromDex); return fromDex; }
  const c = cacheGet(`pool:${mint}`);
  if (c && Date.now() - c.t < 7 * 864e5) return c.v;
  if (gtCooling()) return null;
  try {
    const j = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);
    const pools = (Array.isArray(j.data) ? j.data : []).map((d) => ({ addr: d.attributes && d.attributes.address, liq: Number((d.attributes && d.attributes.reserve_in_usd) || 0) })).filter((p) => p.addr).sort((a, b) => b.liq - a.liq);
    if (pools.length) { cacheSet(`pool:${mint}`, pools[0].addr); return pools[0].addr; }
  } catch (e) { if (e.status === 429 || e.status === 0) gtCooldownUntil = Date.now() + 90000; }
  return null;
}
