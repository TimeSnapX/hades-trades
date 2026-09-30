// One-off: seed trades.json from /home/box/hades/trades.md (hand-transcribed notes
// below) cross-checked against the chain. Chain values always win; every
// annotation here is quoted/paraphrased from trades.md. Usage:
//   node tools/seed.mjs [--out /home/box/hades/trades.json]
import fs from "node:fs";
import { rowFromTx, readDoc, upsert, writeDocAtomic, rpc, WALLET } from "./add-trade.mjs";

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "/home/box/hades/trades.json";
const T101 = (note) => ({ rule_set: "test-under-$20", take_profit: [{ x: 101, sell_frac: null }], stop_x: null, trail_pct: null, time_stop_hours: null, keep_min_frac: 0.1, note });
const T11 = (note) => ({ rule_set: "test-payday-11x", take_profit: [{ x: 11, sell_frac: null }], stop_x: null, trail_pct: null, time_stop_hours: null, keep_min_frac: null, note });
const SRC = "trades.md (Hades log)";

const notes = {
  eZxuLLHTnhPSKfmTa83bWm1agetu9mgcpDztCJj1QELvx7b5GBuWFnFWiuahBx8r7XM7UJGYbLhBtPBqSKFyFqN: { reason: "Starting bank: 0.075348 SOL (~$9.00) on 2026-09-29 9:08pm AEST" },
  "5JHQM8yPqkVtNQ1M1beyy3DBNuZbF1yQ2NUjQaArYXLNHBJHksXaiNf5sNavQuqAAHd4ocfDeWS91F5yctmWbjnM": {
    token: "INUINK",
    entry_snapshot: { source: SRC, notes: "No entry metrics logged." },
    planned_targets: { rule_set: "test-run-initial", take_profit: [], stop_x: 0.5, trail_pct: null, time_stop_hours: null, keep_min_frac: null, note: "Only a -50% stop is recorded in trades.md (\"hit -50% stop at 0.0208\"); take-profit not logged." },
  },
  Py9Zo56RmKNb9wzrCzXvUJjKaykcsioCtJEHGLZ5rMadfNQw6XTNWJ3s6NQmnFdexubRVRc2euVzTaRMPeczYuf: {
    token: "PAYDAY", reason: "Full degen, user-requested 2026-09-29",
    entry_snapshot: { source: SRC, notes: "No entry metrics logged." },
    planned_targets: T11("USER RULE: do NOT sell until position value >= 0.2926 SOL (+1000%, 11x). No stop-loss. Never sell early, not even on a rug (user confirmed 21:31). Superseded 23:09 by the under-$20 101x rule."),
  },
  "2cvToVLXx6H2VV5ABXrAVFgcAKFU2XYXcFhR2H4ghBP9PPBjnm8q11Z2hAEuS72wTpdSFsXuzZjENU1MaUm3vHjc": {
    token: "INUINK", reason: "Hit -50% stop at 0.0208 SOL (entry 0.0416); sold all", exit_reason: "stop",
  },
  "2PDfdgjoWnZJF4S14VZGZKKLXH9HRSufxdbLegk2S4yakDnb3TEomnUTfqBQvSakCFAvwzmzrEgGKwGTBZwJ4dWZ": {
    token: "PAYDAY", reason: "Top-up, user request \"put the rest on payday\"",
    entry_snapshot: { source: SRC, notes: "No entry metrics logged." },
    planned_targets: T11("New 11x (+1000%) target ~0.527 SOL on total cost ~0.0479 SOL; never sell early. Superseded 23:09 by the 101x rule."),
  },
  "5HuoAZ3wFa735ozE5ATTUdbnmG2yfHDXrAwaB91oWGVXewtcYMQvX38KEg337PTpfeJDCJ3MpGWk4YfRyhcDDQ2E": { reason: "User sent ~$8 of SOL (bankroll top-up)" },
  "3Qo5xHmLVPhgcf9AyTTJxTkse5S3drEa5D9LPzu3ZBTYQ4Xq35Dofahtv2XJB6KEpaDxA57bqap74hXf3RyUG15H": {
    token: "PAYDAY", reason: "User: \"put it all on PAYDAY\"",
    entry_snapshot: { source: SRC, notes: "No entry metrics logged at entry. (Manager check 2026-09-30 17:58: RugCheck score 1, LP ~$9.9k; not entry-time values.)" },
    planned_targets: T101("Logged 22:28 with an 11x target (~1.26 SOL). 23:09 rule change: under $20 hold until +10,000% (101x, ~11.56 SOL on ~0.1145 SOL cost), no early sell, always keep >= 10%. Sell fraction at 101x not specified."),
  },
  "4fNqr2uMvF7jprTfgPwjNhR12uutkv61Zz5aEkG8LGM7kSpMHqD8mwzP3jSxW31i82ZcSseQzeCCo9d42tYsRSXv": { reason: "Deposit received ~0.315732 SOL (total deposited ~0.4577 SOL)" },
  "3GPJ2SL3yr6REFDHBnLj7LLPZLoLAQwxpUTLNLgTXEYVTFLLFTZ1eqD16eUbc3k8nb6Ju7fZLErexrVB2STtTNu6": {
    token: "RESI",
    reason: "User picked from shortlist. Launched today 09:02 AEST, mcap ~$197k, liq ~$47k, 24h vol $5.5M, bought after -79% 6h dump; RugCheck clean, mint/freeze revoked, LP locked, top10 ~30%.",
    entry_snapshot: {
      liquidity_usd: 47000, volume24h_usd: 5500000, age_hours: 8.91, top10_pct: 30, rugcheck_score: 1,
      filters_passed: ["mint_freeze_revoked", "lp_locked_or_burned", "rugcheck_no_warnings"],
      source: SRC,
      notes: "Approximate (~) values from the 17:57 buy note; age = 17:56:28 entry minus 09:02 launch; rugcheck_score from the 17:58 manager check. not_after_pump left unknown (-79% dump logged, steady buy volume not logged); dev/insiders not logged.",
    },
    planned_targets: T101("Under-$20 rule: hold to 101x (~8.23 SOL), keep >= 10%."),
  },
  "3knvAmdYnSjuHe3mPXZ6L9DeSm2ZCHbUEapBbQSKrMRLe9Z6RW7J9cervpYzttV7pojWjj2VubAn4b1mh5Y5xFfy": {
    token: "SI", reason: "User request (runner-up from today's screen); RugCheck score 1, no risks, LP ~96% locked.",
    entry_snapshot: { rugcheck_score: 1, filters_passed: ["lp_locked_or_burned", "rugcheck_no_warnings"], source: SRC, notes: "Only RugCheck and LP lock logged at entry." },
    planned_targets: T101("Under-$20 rule: hold to 101x (~10.26 SOL), keep >= 10%."),
  },
};

const sigs = (await rpc("getSignaturesForAddress", [WALLET, { limit: 100 }])).filter((s) => !s.err).map((s) => s.signature).reverse();
let doc = readDoc(out);
for (const sig of sigs) {
  if (!notes[sig]) { console.log("on chain but not in trades.md, skipped:", sig); continue; }
  const row = await rowFromTx(sig, notes[sig]);
  const r = upsert(doc, row, { replace: true });
  doc = r.doc;
  console.log(row.time_aest, row.action, row.token, row.sol, row.tokens, "unverified:", row.unverified.join(","));
  await new Promise((r) => setTimeout(r, 400));
}
for (const sig of Object.keys(notes)) if (!sigs.includes(sig)) console.log("in trades.md but NOT found on chain:", sig);
writeDocAtomic(out, doc);
console.log("wrote", out, doc.trades.length, "rows");
