// Tests for tools/add-trade.mjs (offline: chain data from saved real transactions).
//   node tests/add-trade.test.mjs            (add --live to also hit a public RPC)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.ADD_TRADE || path.join(here, "..", "tools", "add-trade.mjs");
const FIX = (f) => path.join(here, "fixtures", f);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hades-add-"));
const file = path.join(dir, "trades.json");
const SI = "3knvAmdYnSjuHe3mPXZ6L9DeSm2ZCHbUEapBbQSKrMRLe9Z6RW7J9cervpYzttV7pojWjj2VubAn4b1mh5Y5xFfy";
const SELL = "2cvToVLXx6H2VV5ABXrAVFgcAKFU2XYXcFhR2H4ghBP9PPBjnm8q11Z2hAEuS72wTpdSFsXuzZjENU1MaUm3vHjc";
const DEP = "eZxuLLHTnhPSKfmTa83bWm1agetu9mgcpDztCJj1QELvx7b5GBuWFnFWiuahBx8r7XM7UJGYbLhBtPBqSKFyFqN";
const run = (args, ok = true) => {
  let out;
  try { out = execFileSync("node", [CLI, "--file", file, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { if (ok) throw new Error(`${args.join(" ")} failed: ${e.stderr || e.message}`); return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
  if (!ok) assert.fail(`expected failure but succeeded: ${args.join(" ")}\n${out}`);
  return { code: 0, out };
};
const doc = () => JSON.parse(fs.readFileSync(file, "utf8"));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok -", name); };

test("--from-tx BUY (offline, saved tx): exact chain values, snapshot validated + auto filters", () => {
  run(["--from-tx", SI, "--tx-json", FIX("tx-si-buy.json"), "--offline", "--token", "SI", "--reason", "test buy",
    "--snapshot", JSON.stringify({ liquidity_usd: 150000, volume24h_usd: 100000, age_hours: 20, top10_pct: 30, rugcheck_score: 1, filters_passed: ["rugcheck_no_warnings"] })]);
  const t = doc().trades[0];
  assert.equal(t.action, "BUY"); assert.equal(t.token, "SI"); assert.equal(t.mint, "7Wh6rxVWUBFCNCWCz7nLaV7z3SDr2M6rFTjjWP6aE8p1");
  assert.equal(t.sol, 0.101599841); assert.equal(t.tokens, 85212.77177); assert.equal(t.fee_sol, 0.000936001); assert.equal(t.rent_sol, 0.00151384);
  assert.equal(t.time_aest, "2026-09-30T17:59:21+10:00"); assert.equal(t.run, "test"); assert.equal(t.id, "buy-si-3knvAmdY");
  assert.deepEqual(t.entry_snapshot.filters_passed, ["liquidity_100k", "age_12h_14d", "rugcheck_no_warnings"]);
  assert.deepEqual(t.entry_snapshot.filters_failed, ["volume24h_250k", "top10_lt_25pct"]);
  assert.ok(t.unverified.includes("usd_at_time"), "offline -> usd_at_time unverified");
  assert.equal(t.usd_at_time, null);
  assert.equal(t.trader, "agent", "Hades' default"); assert.equal(t.trader_source, "logged");
});
test("dedupe by tx (exit code 3, file unchanged)", () => {
  const before = fs.readFileSync(file, "utf8");
  const r = run(["--from-tx", SI, "--tx-json", FIX("tx-si-buy.json"), "--offline", "--token", "SI"], false);
  assert.equal(r.code, 3); assert.match(r.out, /duplicate/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
test("rows are kept sorted (older rows inserted later go first)", () => {
  run(["--from-tx", DEP, "--tx-json", FIX("tx-deposit.json"), "--offline", "--reason", "bank"]);
  run(["--from-tx", SELL, "--tx-json", FIX("tx-inuink-sell.json"), "--offline", "--token", "INUINK", "--exit-reason", "stop", "--reason", "stop hit"]);
  const d = doc();
  assert.deepEqual(d.trades.map((t) => t.action), ["DEPOSIT", "SELL", "BUY"]);
  assert.equal(d.trades[0].sol, 0.075347871); assert.equal(d.trades[0].token, "SOL"); assert.equal(d.trades[0].mint, null);
  assert.equal(d.trades[1].exit_reason, "stop"); assert.equal(d.trades[1].sol, 0.020480229);
});
test("atomic write: .bak kept, no temp files, lock released, --validate OK", () => {
  const files = fs.readdirSync(dir);
  assert.ok(files.includes("trades.json.bak"));
  assert.deepEqual(files.filter((f) => f.endsWith(".tmp") || f.endsWith(".lock")), []);
  assert.match(run(["--validate"]).out, /OK .* 3 rows/);
});
test("rejects bad input: unknown filter, bad exit_reason, chain-field disagreement, invalid manual row", () => {
  const before = fs.readFileSync(file, "utf8");
  assert.match(run(["--from-tx", SI, "--tx-json", FIX("tx-si-buy.json"), "--offline", "--replace", "--snapshot", '{"filters_passed":["moon"]}'], false).out, /unknown filter "moon"/);
  assert.match(run(["--from-tx", SELL, "--tx-json", FIX("tx-inuink-sell.json"), "--offline", "--replace", "--exit-reason", "yolo"], false).out, /exit_reason/);
  assert.match(run(["--from-tx", SI, "--tx-json", FIX("tx-si-buy.json"), "--offline", "--replace", "--json", '{"sol":0.5}'], false).out, /disagrees with chain/);
  assert.match(run(["--json", JSON.stringify({ action: "BUY", tx: "x" })], false).out, /invalid/);
  assert.match(run(["--from-tx", "not-a-sig"], false).out, /signature/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "file untouched by rejected rows");
});
test("--replace updates an existing row (reason/snapshot) without duplicating", () => {
  run(["--from-tx", SI, "--tx-json", FIX("tx-si-buy.json"), "--offline", "--replace", "--token", "SI", "--reason", "updated", "--snapshot", '{"liquidity_usd":90000}']);
  const d = doc();
  assert.equal(d.trades.length, 3);
  const t = d.trades.find((x) => x.tx === SI);
  assert.equal(t.reason, "updated"); assert.equal(t.token, "SI"); assert.equal(t.entry_snapshot.liquidity_usd, 90000); assert.equal(t.entry_snapshot.age_hours, 20);
  assert.ok(t.entry_snapshot.filters_failed.includes("liquidity_100k")); assert.ok(!t.entry_snapshot.filters_passed.includes("liquidity_100k"));
});
test("manual --json row (no chain) validates, dedupes and sorts", () => {
  const row = { time_aest: "2026-09-29T21:00:00+10:00", action: "DEPOSIT", token: "SOL", mint: null, sol: 0.01, tokens: null, usd_at_time: null, fee_sol: 0, price_expected: null, price_filled: null, tx: "5".repeat(87), reason: "manual", run: "test", entry_snapshot: null, exit_reason: null, planned_targets: null };
  run(["--json", JSON.stringify(row)]);
  const d = doc();
  assert.equal(d.trades[0].tx, "5".repeat(87)); assert.equal(d.trades[0].id, "deposit-sol-55555555");
  assert.equal(run(["--json", JSON.stringify(row)], false).code, 3);
});
test("--dry-run does not write", () => {
  const before = fs.readFileSync(file, "utf8");
  const row = { time_aest: "2026-09-29T21:01:00+10:00", action: "DEPOSIT", token: "SOL", mint: null, sol: 0.02, tokens: null, usd_at_time: null, fee_sol: 0, price_expected: null, price_filled: null, tx: "6".repeat(87), reason: null, run: "test", entry_snapshot: null, exit_reason: null, planned_targets: null };
  assert.match(run(["--dry-run", "--json", JSON.stringify(row)]).out, /DRY RUN/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

// ---- Me vs Agent: --trader, --backfill-trader, --apply-overrides, --sync-unlogged, sponsored sells
const FN = { in: "SkvD27sFoNyrqb8vQKbBaaerZXehmAx2wmnHnnnpfGEEEtyeZ25wwPdjNQ76insbBHvfnc7CxFxxs7uTgZbFnWG", sell: "5R3vdsp3usSRF3eLgS2Pe1ww3iT1qZtNUYn6iXZa6kabM7oYVVyCwembErH3KbtECJHFYGTPL8pMy5AR7sASVs57", out: "2JkGSEg6c8JvRXGoHAvi9jRhfMZWuRhCLbmQxHSVZvwE3NAFVL8fteGzd3vGXDkdCZAgUghBfzTZh8SUn3vpoacy", buy: "4pewFGCGnLkDFmEWPcTVtu9T3nGaqt6dg95PUuxuRdGMnvXGLMbYJR6dsxsW6PoxBmdqQo91HiNAzK23rmzb1SnH", relay: "3r2MYM7PPj44y56rChwrJB1StJdJrbBBuXAnyMF1m8qSHjmZM4iZ2A9LtE85rkyBSkjiHJdgGHtzfR9tXSsct6jd" };
test("deposits default to human; --trader human on a swap is 'logged'", () => {
  const d = doc().trades.find((t) => t.tx === DEP);
  assert.equal(d.trader, "human"); assert.equal(d.trader_source, "inferred");
  run(["--from-tx", SI, "--tx-json", FIX("tx-si-buy.json"), "--offline", "--replace", "--trader", "human"]);
  const t = doc().trades.find((x) => x.tx === SI);
  assert.equal(t.trader, "human"); assert.equal(t.trader_source, "logged"); assert.equal(t.reason, "updated", "replace keeps fields");
  assert.match(run(["--from-tx", SI, "--trader", "robot"], false).out, /--trader must be agent or human/);
});
test("--backfill-trader fills legacy rows only", () => {
  const legacy = path.join(dir, "legacy.json");
  const d = doc(); d.trades = d.trades.map(({ trader, trader_source, ...t }) => t);
  fs.writeFileSync(legacy, JSON.stringify(d));
  execFileSync("node", [CLI, "--file", legacy, "--backfill-trader"]);
  const b = JSON.parse(fs.readFileSync(legacy, "utf8")).trades;
  assert.deepEqual(b.map((t) => `${t.action}:${t.trader}:${t.trader_source}`).filter((x, i, a) => a.indexOf(x) === i).sort(), ["BUY:agent:logged", "DEPOSIT:human:inferred", "SELL:agent:logged"].filter((x) => b.some((t) => x.startsWith(t.action))).sort());
});
test("--apply-overrides merges the app export (manual_override), reports unknown txs", () => {
  const ov = path.join(dir, "ov.json");
  fs.writeFileSync(ov, JSON.stringify({ schema: "ht-trader-overrides/1", overrides: [{ tx: SELL, trader: "human" }, { tx: "4".repeat(87), trader: "agent" }] }));
  const r = run(["--apply-overrides", ov]);
  assert.match(r.out, /applied 1 override/); assert.match(r.out, /not in the file/);
  const t = doc().trades.find((x) => x.tx === SELL);
  assert.equal(t.trader, "human"); assert.equal(t.trader_source, "manual_override");
  assert.match(run(["--validate"]).out, /OK/);
});
test("--from-tx on a Phantom sponsored sell: one SELL row with linked loan txs", () => {
  const f2 = path.join(dir, "sp.json");
  const r = execFileSync("node", [CLI, "--file", f2, "--from-tx", FN.sell, "--tx-json", FIX("tx-fundnet-sell.json"), "--linked-tx-json", `${FIX("tx-fundnet-loan-in.json")},${FIX("tx-fundnet-loan-out.json")}`, "--offline", "--sol-usd", "120", "--token", "FUNDNET", "--trader", "human", "--reason", "manual (user)"], { encoding: "utf8" });
  assert.match(r, /ADDED/);
  const t = JSON.parse(fs.readFileSync(f2, "utf8")).trades[0];
  assert.equal(t.action, "SELL"); assert.equal(t.sol, 0.041304375); assert.equal(t.wallet_sol_delta, 0); assert.equal(t.rent_sol, -0.00151384);
  assert.deepEqual(t.linked_txs, [FN.in, FN.out]); assert.equal(t.proceeds_external.asset, "CASH"); assert.equal(t.proceeds_external.amount, 4.956525);
  assert.equal(t.trader, "human");
  // a linked tx can't be logged again on its own
  const again = (() => { try { execFileSync("node", [CLI, "--file", f2, "--from-tx", FN.in, "--tx-json", FIX("tx-fundnet-loan-in.json"), "--offline"], { encoding: "utf8", stdio: "pipe" }); return 0; } catch (e) { return e.status; } })();
  assert.equal(again, 3);
});
test("--sync-unlogged (offline): unlogged swaps -> human/inferred, bundles merged, bridge out = WITHDRAW", () => {
  const f3 = path.join(dir, "sync.json");
  fs.writeFileSync(f3, JSON.stringify({ schema_version: 1, wallet: "CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f", gmgn: "x", real_run_start_aest: "2026-10-06T21:12:00+10:00", updated_aest: "2026-10-01T21:00:00+10:00", trades: [] }));
  const txd = path.join(dir, "txs"); fs.mkdirSync(txd, { recursive: true });
  const map = { [FN.in]: "tx-fundnet-loan-in.json", [FN.sell]: "tx-fundnet-sell.json", [FN.out]: "tx-fundnet-loan-out.json", [FN.buy]: "tx-fundnet-buy.json", [FN.relay]: "tx-relay-withdraw.json" };
  for (const [sig, f] of Object.entries(map)) fs.copyFileSync(FIX(f), path.join(txd, `${sig}.json`));
  const sigs = Object.keys(map).map((signature, i) => ({ signature, blockTime: 1790853540 + i, err: null }));
  fs.writeFileSync(path.join(dir, "sigs.json"), JSON.stringify(sigs));
  const args = [CLI, "--file", f3, "--sync-unlogged", "--sigs-json", path.join(dir, "sigs.json"), "--tx-dir", txd, "--offline", "--sol-usd", "120"];
  const dry = execFileSync("node", [...args, "--dry-run"], { encoding: "utf8" });
  assert.match(dry, /would add 3 row/); assert.equal(JSON.parse(fs.readFileSync(f3, "utf8")).trades.length, 0);
  const out = execFileSync("node", args, { encoding: "utf8" });
  assert.match(out, /added 3 row\(s\), skipped 0/);
  const t = JSON.parse(fs.readFileSync(f3, "utf8")).trades;
  assert.deepEqual(t.map((x) => x.action), ["WITHDRAW", "BUY", "SELL"]);
  assert.ok(t.every((x) => x.trader === "human" && x.trader_source === "inferred" && x.reason === "manual (user)" && x.run === "test"));
  assert.equal(t[2].exit_reason, "manual"); assert.equal(t[2].linked_txs.length, 2); assert.equal(t[1].planned_targets, null);
  assert.match(execFileSync("node", args, { encoding: "utf8" }), /0 not in/);
});
// concurrent writers (lock): 4 processes at once, all rows must land
{
  const rows = [7, 8, 9, "A"].map((c, i) => ({ time_aest: `2026-09-29T21:1${i}:00+10:00`, action: "DEPOSIT", token: "SOL", mint: null, sol: 0.001 * (i + 1), tokens: null, usd_at_time: null, fee_sol: 0, price_expected: null, price_filled: null, tx: String(c).repeat(87), reason: null, run: "test", entry_snapshot: null, exit_reason: null, planned_targets: null }));
  const before = doc().trades.length;
  await Promise.all(rows.map((r) => new Promise((res, rej) => { const p = spawn("node", [CLI, "--file", file, "--json", JSON.stringify(r)], { stdio: "ignore" }); p.on("exit", (c) => (c === 0 ? res() : rej(new Error("exit " + c)))); })));
  test("concurrent writers are serialised by the lock (no lost rows)", () => { assert.equal(doc().trades.length, before + 4); assert.match(run(["--validate"]).out, /OK/); });
}
if (process.argv.includes("--live")) {
  const live = path.join(dir, "live.json");
  const out = execFileSync("node", [CLI, "--file", live, "--from-tx", SI, "--token", "SI", "--dry-run"], { encoding: "utf8" });
  test("--from-tx live (public RPC + Kraken SOL/USD + DexScreener symbol)", () => {
    assert.match(out, /"sol": 0\.101599841/); assert.match(out, /"usd_source": "kraken SOLUSD/); assert.match(out, /DRY RUN/);
  });
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} add-trade tests passed`);
