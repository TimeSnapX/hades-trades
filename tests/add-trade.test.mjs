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
