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
    unverified,
  };
}
