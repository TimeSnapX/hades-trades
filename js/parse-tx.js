// Hades Trades: parse a jsonParsed Solana transaction into a trade row draft.
// Shared by the web app (unlogged-activity preview) and add-trade.mjs --from-tx.
// Pure functions, no network. Amounts are computed in integer lamports / raw
// token units and only converted to decimals at the end.

export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
const SYSTEM = "11111111111111111111111111111111";
// USD stablecoins a Phantom sell can settle into (proceeds paid to another account).
export const STABLES = {
  CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH: "CASH",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
};

// ---- ed25519 on-curve check (PDAs, e.g. pool vault authorities, are off-curve;
// user wallets are on-curve). Used to tell a payout wallet from a pool account.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
const P25519 = 2n ** 255n - 19n;
const modp = (a) => ((a % P25519) + P25519) % P25519;
function powmod(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = (r * b) % P25519; b = (b * b) % P25519; e >>= 1n; } return r; }
const D25519 = modp(-121665n * powmod(121666n, P25519 - 2n));
export function isOnCurve(address) {
  let bytes;
  try { bytes = b58decode(address); } catch { return false; }
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  const sign = bytes[31] >> 7;
  if (y >= P25519) return false;
  const y2 = (y * y) % P25519;
  const u = modp(y2 - 1n), v = modp(D25519 * y2 + 1n);
  const x2 = (u * powmod(v, P25519 - 2n)) % P25519;
  if (x2 === 0n) return sign === 0;
  return powmod(x2, (P25519 - 1n) / 2n) === 1n;
}
// Phantom's swap fee is 0.85% of the swap. Fees are detected by that pattern.
export const PLATFORM_FEE_RATE = 0.0085;

const LAMPORTS = 1_000_000_000;
export const lamportsToSol = (l) => Math.round(Number(l)) / LAMPORTS;
export const round = (n, dp = 9) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(dp)));

// Unix seconds -> "2026-09-29T21:13:20+10:00" (Brisbane, no DST).
export function toAest(unix) {
  const d = new Date((unix + 10 * 3600) * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "+10:00");
}
export function aestToUnix(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

function rawToUi(raw, decimals) {
  const neg = raw < 0n;
  let s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return Number((neg ? "-" : "") + int + (frac ? "." + frac : ""));
}

function keyList(tx) {
  return tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
}

// Returns a draft row plus diagnostics. Never guesses: fields it cannot
// determine are null and named in `unverified`.
export function parseTx(tx, wallet) {
  if (!tx || !tx.meta) throw new Error("transaction not found or missing meta");
  const meta = tx.meta;
  const keys = keyList(tx);
  const sig = tx.transaction.signatures[0];
  const wi = keys.indexOf(wallet);
  if (wi < 0) throw new Error("wallet is not an account in this transaction");
  const payer = keys[0] === wallet;
  const solDelta = BigInt(meta.postBalances[wi]) - BigInt(meta.preBalances[wi]);
  const networkFee = payer ? BigInt(meta.fee) : 0n;

  // Wallet-owned token accounts, their mints and lamport (rent) changes.
  const owned = new Map(); // accountIndex -> {mint, program, preRaw, postRaw, decimals}
  const note = (b, which) => {
    if (b.owner !== wallet) return;
    const e = owned.get(b.accountIndex) || { mint: b.mint, program: b.programId || null, preRaw: 0n, postRaw: 0n, decimals: b.uiTokenAmount.decimals };
    e[which] = BigInt(b.uiTokenAmount.amount);
    owned.set(b.accountIndex, e);
  };
  (meta.preTokenBalances || []).forEach((b) => note(b, "preRaw"));
  (meta.postTokenBalances || []).forEach((b) => note(b, "postRaw"));

  // Accounts initialised in this tx (temp WSOL accounts etc.).
  const allIns = [
    ...tx.transaction.message.instructions.map((i) => ({ top: true, i })),
    ...(meta.innerInstructions || []).flatMap((x) => x.instructions.map((i) => ({ top: false, i }))),
  ];
  const wsolAccounts = new Set();
  const walletAccounts = new Set([wallet]);
  for (const [idx, e] of owned) {
    walletAccounts.add(keys[idx]);
    if (e.mint === WSOL) wsolAccounts.add(keys[idx]);
  }
  for (const { i } of allIns) {
    const p = i.parsed;
    if (!p || typeof p !== "object") continue;
    if (/^initializeAccount/.test(p.type) && p.info) {
      if (p.info.owner === wallet) walletAccounts.add(p.info.account);
      if (p.info.mint === WSOL) wsolAccounts.add(p.info.account);
    }
    if (p.type === "closeAccount" && p.info && p.info.owner === wallet) walletAccounts.add(p.info.account);
  }

  // Token deltas per mint (excluding WSOL) and rent locked/refunded.
  const byMint = new Map();
  let rent = 0n;
  for (const [idx, e] of owned) {
    if (e.mint === WSOL) continue;
    const m = byMint.get(e.mint) || { raw: 0n, decimals: e.decimals, program: e.program };
    m.raw += e.postRaw - e.preRaw;
    byMint.set(e.mint, m);
    rent += BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
  }
  const changed = [...byMint].filter(([, m]) => m.raw !== 0n);
  // Wallet token accounts closed in this tx (listed before, gone after).
  const postIdx = new Set((meta.postTokenBalances || []).filter((b) => b.owner === wallet).map((b) => b.accountIndex));
  const closedMints = [...new Set([...owned].filter(([idx, e]) => !postIdx.has(idx) && e.mint !== WSOL).map(([, e]) => e.mint))];

  // SOL flows (system transfers, WSOL token transfers).
  const flows = [];
  for (const { top, i } of allIns) {
    const p = i.parsed;
    if (!p || typeof p !== "object" || !p.info) continue;
    const inf = p.info;
    if (i.program === "system" && p.type === "transfer") {
      flows.push({ top, src: inf.source, dst: inf.destination, lamports: BigInt(inf.lamports) });
    } else if (i.program === "spl-token" && (p.type === "transfer" || p.type === "transferChecked")) {
      const isWsol = inf.mint === WSOL || wsolAccounts.has(inf.source) || wsolAccounts.has(inf.destination);
      if (!isWsol) continue;
      const amt = inf.tokenAmount ? BigInt(inf.tokenAmount.amount) : BigInt(inf.amount);
      flows.push({ top, src: inf.source, dst: inf.destination, lamports: amt });
    }
  }
  const fromWallet = (f) => walletAccounts.has(f.src) && !walletAccounts.has(f.dst);

  let action = null;
  let mint = null;
  let tokensRaw = 0n;
  let decimals = null;
  let program = null;
  let kind = "OTHER";
  if (changed.length === 1) {
    [mint, { raw: tokensRaw, decimals, program }] = changed[0];
    if (tokensRaw > 0n && solDelta < 0n) action = "BUY";
    else if (tokensRaw < 0n && solDelta > 0n) action = "SELL";
    else kind = tokensRaw > 0n ? "TOKEN_IN" : "TOKEN_OUT";
  } else if (changed.length === 0) {
    if (solDelta > 0n && !payer) action = "DEPOSIT";
    else if (solDelta < 0n && flows.some((f) => f.top && f.src === wallet && !walletAccounts.has(f.dst))) action = "WITHDRAW";
    // SOL sent out through a program (e.g. a Relay bridge deposit_native): an inner transfer.
    else if (solDelta < 0n && payer && flows.some((f) => !f.top && f.src === wallet && !walletAccounts.has(f.dst)) && flows.filter((f) => f.src === wallet && !walletAccounts.has(f.dst)).reduce((a, f) => a + f.lamports, 0n) * 10n >= -solDelta * 9n) action = "WITHDRAW";
  } else {
    kind = "MULTI_TOKEN";
  }
  if (action) kind = action;

  // Tips: top-level system transfers from the wallet to outside accounts (swaps only).
  let tip = 0n;
  if (action === "BUY" || action === "SELL") {
    for (const f of flows) if (f.top && f.src === wallet && !walletAccounts.has(f.dst) && f.lamports < 1_000_000n) tip += f.lamports;
  }
  // Platform fee: outflows equal to 0.85% of another SOL flow (or of flow + fee).
  let platform = 0n;
  let platformDetected = false;
  if (action === "BUY" || action === "SELL") {
    const amounts = flows.map((f) => f.lamports);
    const feeDst = new Set();
    for (const f of flows) {
      if (!fromWallet(f) || f.top) continue;
      const a = Number(f.lamports);
      const hit = amounts.some((b) => {
        const bn = Number(b);
        if (b === f.lamports) return false;
        return Math.abs(a - PLATFORM_FEE_RATE * bn) <= 2 || Math.abs(a - PLATFORM_FEE_RATE * (bn + a)) <= 2;
      });
      if (hit) feeDst.add(f.dst);
    }
    for (const f of flows) if (!f.top && fromWallet(f) && feeDst.has(f.dst)) platform += f.lamports;
    platformDetected = feeDst.size > 0;
  }

  // A token leaving the wallet while a USD stablecoin lands in another (on-curve)
  // wallet in the same tx: a sell whose proceeds were paid to another account.
  let externalProceeds = null;
  if (kind === "TOKEN_OUT") {
    const acc = new Map();
    const add = (b, which) => {
      if (!(b.mint in STABLES) || b.owner === wallet) return;
      const e = acc.get(b.accountIndex) || { owner: b.owner, mint: b.mint, decimals: b.uiTokenAmount.decimals, pre: 0n, post: 0n };
      e[which] = BigInt(b.uiTokenAmount.amount);
      acc.set(b.accountIndex, e);
    };
    (meta.preTokenBalances || []).forEach((b) => add(b, "pre"));
    (meta.postTokenBalances || []).forEach((b) => add(b, "post"));
    const cands = [...acc.values()].filter((e) => e.post > e.pre && isOnCurve(e.owner)).sort((a, b) => (b.post - b.pre > a.post - a.pre ? 1 : -1));
    if (cands.length) {
      const c = cands[0];
      externalProceeds = { asset: STABLES[c.mint], mint: c.mint, amount: rawToUi(c.post - c.pre, c.decimals), to: c.owner };
    }
  }

  const sol = solDelta < 0n ? -solDelta : solDelta;
  let swapLamports = null;
  if (action === "BUY") swapLamports = -solDelta - rent - networkFee - tip;
  if (action === "SELL") swapLamports = solDelta + rent + networkFee + tip;
  const tokens = mint ? Math.abs(rawToUi(tokensRaw, decimals)) : null;
  const unverified = [];
  if (!platformDetected && (action === "BUY" || action === "SELL")) unverified.push("platform_fee_sol");

  return {
    tx: sig,
    ok: meta.err == null,
    kind,
    action,
    time_unix: tx.blockTime,
    time_aest: tx.blockTime ? toAest(tx.blockTime) : null,
    mint,
    token_program: program,
    decimals,
    tokens,
    sol: lamportsToSol(sol),
    sol_delta: lamportsToSol(solDelta),
    rent_sol: lamportsToSol(rent),
    fee_breakdown: {
      network_sol: lamportsToSol(networkFee),
      tip_sol: lamportsToSol(tip),
      platform_sol: platformDetected ? lamportsToSol(platform) : null,
    },
    fee_sol: lamportsToSol(networkFee + tip + platform),
    swap_sol: swapLamports == null ? null : lamportsToSol(swapLamports),
    price_filled: swapLamports != null && tokens ? round(lamportsToSol(swapLamports) / tokens, 15) : null,
    counterparty: action === "DEPOSIT" ? (flows.find((f) => f.dst === wallet) || {}).src || null : null,
    fee_payer: keys[0],
    closed_mints: closedMints,
    external_proceeds: externalProceeds,
    unverified,
  };
}

// ---- Phantom gas-sponsored sells -------------------------------------------
// Phantom can sell a token with the proceeds paid out in a stablecoin to another
// account, sponsoring the gas: (1) a sponsor S lends SOL to the wallet (DEPOSIT
// from S), (2) the wallet swaps the token with the output sent elsewhere
// (TOKEN_OUT with external_proceeds), (3) S takes the loan back while the token
// account is closed (WITHDRAW, fee paid by S). Returns
// [{main, loanIn, loanOut}] for every TOKEN_OUT with external proceeds; loanIn /
// loanOut are null when not found within `windowSec`.
export function findSponsoredSells(drafts, { wallet, windowSec = 120 } = {}) {
  const sorted = [...drafts].filter((d) => d && d.ok !== false).sort((a, b) => (a.time_unix || 0) - (b.time_unix || 0));
  const used = new Set();
  const out = [];
  for (const m of sorted) {
    if (m.kind !== "TOKEN_OUT" || !m.external_proceeds) continue;
    const near = (d) => d !== m && !used.has(d.tx) && Math.abs((d.time_unix || 0) - (m.time_unix || 0)) <= windowSec;
    const loanOut = sorted.find((d) => near(d) && d.action === "WITHDRAW" && d.fee_payer && d.fee_payer !== wallet && (d.closed_mints || []).includes(m.mint)) || null;
    const sponsor = loanOut ? loanOut.fee_payer : null;
    const loanIn = sponsor ? sorted.find((d) => near(d) && d.action === "DEPOSIT" && d.counterparty === sponsor && (d.time_unix || 0) <= (m.time_unix || 0)) || null : null;
    used.add(m.tx); if (loanOut) used.add(loanOut.tx); if (loanIn) used.add(loanIn.tx);
    out.push({ main: m, loanIn, loanOut });
  }
  return out;
}

// Chain-derived fields of the SELL row for a sponsored sell (see SCHEMA.md,
// proceeds_external). solUsd: SOL/USD at the time (stablecoin taken as 1 USD).
//   wallet_sol_delta = exact net SOL change of the wallet across the bundle
//   sol              = SOL value of the external proceeds + wallet_sol_delta
//   rent_sol         = token-account rent change across the bundle (closed: < 0)
export function sponsoredSellFields(bundle, solUsd) {
  const { main, loanIn, loanOut } = bundle;
  const parts = [loanIn, main, loanOut].filter(Boolean);
  const lam = (x) => BigInt(Math.round(x * LAMPORTS));
  const w = parts.reduce((a, d) => a + lam(d.sol_delta), 0n);
  const rent = parts.reduce((a, d) => a + lam(d.rent_sol), 0n);
  const ext = main.external_proceeds;
  const usd = ext.amount; // USD stablecoin
  const solEquiv = solUsd ? round(usd / solUsd, 9) : null;
  const walletSol = lamportsToSol(w);
  const sol = solEquiv == null ? null : round(solEquiv + walletSol, 9);
  const network = parts.filter((d) => d.fee_payer === main.fee_payer).reduce((a, d) => a + lam(d.fee_breakdown.network_sol), 0n);
  return {
    tx: main.tx,
    time_aest: main.time_aest,
    time_unix: main.time_unix,
    action: "SELL",
    mint: main.mint,
    tokens: main.tokens,
    token_program: main.token_program,
    sol,
    wallet_sol_delta: walletSol,
    rent_sol: lamportsToSol(rent),
    fee_sol: lamportsToSol(network),
    fee_breakdown: { network_sol: lamportsToSol(network), tip_sol: 0, platform_sol: null },
    price_filled: solEquiv != null && main.tokens ? round(solEquiv / main.tokens, 15) : null,
    linked_txs: [loanIn, loanOut].filter(Boolean).map((d) => d.tx),
    proceeds_external: { asset: ext.asset, mint: ext.mint, amount: ext.amount, to: ext.to, usd_equiv: usd, sol_equiv: solEquiv },
    complete: !!(loanIn && loanOut) || (!loanIn && !loanOut),
  };
}
