// Headless Chrome, phone viewport (390x844), local server, mocked RPC / Jupiter /
// DexScreener / FX / GeckoTerminal. Every number is checked against the hand
// calculations in tests/EXPECTED.md.
//   node tests/e2e.mjs            (needs playwright-core + /usr/bin/google-chrome)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { start } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || "/usr/local/lib/node_modules", "package.json"));
const { chromium } = req("playwright-core");
const PORT = Number(process.env.PORT || 4732);
const BASE = `http://127.0.0.1:${PORT}/hades-trades/`;
const SHOTS = process.env.HT_SHOTS || path.join(here, "..", "test-results");
fs.mkdirSync(SHOTS, { recursive: true });
const fx = (f) => fs.readFileSync(path.join(here, "fixtures", f), "utf8");
const W = "CUSovgfxny4rpNf3S6wwqYE2gGHABZdyVUa4QEoryS8f";
const WSOL = "So11111111111111111111111111111111111111112";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const mint = (k) => (k + "mint").padEnd(44, "1");
const SI_SIG = "3knvAmdYnSjuHe3mPXZ6L9DeSm2ZCHbUEapBbQSKrMRLe9Z6RW7J9cervpYzttV7pojWjj2VubAn4b1mh5Y5xFfy";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" };
const PRICES = { AAA: 0.0002, BBB: 0.0002, CCC: 0.0002, DDD: 0.0015, EEE: 0.0001, FFF: 0.0001, GGG: 0.0003, XXX: 0.0002, YYY: 0.0002, ZZZ: 0.0015, WWW: 0.0005 };
const sig = (k) => ("Mock" + k).replace(/[0OIl]/g, "x").padEnd(88, "1");

let passed = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); passed++; results.push(`ok - ${name}`); console.log(`ok - ${name}`); }
  catch (e) { results.push(`FAIL - ${name}: ${e.message}`); console.log(`FAIL - ${name}\n   ${e.message}`); process.exitCode = 1; }
}

function mocks(target, o) {
  const calls = [];
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
  const preflight = (route) => route.request().method() === "OPTIONS" && (route.fulfill({ status: 204, headers: CORS }), true);
  const doc = JSON.parse(fx(o.fixture));
  return Promise.all([
    target.route("**/hades-trades/data/trades.json*", async (r) => { if (o.slowData) await new Promise((res) => setTimeout(res, o.slowData)); return r.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(doc) }); }),
    target.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/css" }, body: "" })),
    target.route(/solana-rpc\.publicnode\.com|rpc\.solanatracker\.io|api\.mainnet-beta\.solana\.com/, (route) => {
      if (preflight(route)) return;
      const host = new URL(route.request().url()).host;
      const body = JSON.parse(route.request().postData() || "{}");
      calls.push(`${host} ${body.method}`);
      if (o.fail) return json(route, { error: "boom" }, 500);
      const err = (code, message) => json(route, { jsonrpc: "2.0", id: 1, error: { code, message } });
      if (body.method === "getSignaturesForAddress" && host.startsWith("solana-rpc")) return err(429, "Too many requests for a specific RPC call");
      if (body.method === "getTokenAccountsByOwner" && o.noIndexed) return host.startsWith("solana-rpc") ? err(-32602, "Indexed requests require a personal token") : err(-32601, "Method getTokenAccountsByOwner is not allowed");
      const ok = (result) => json(route, { jsonrpc: "2.0", id: 1, result });
      switch (body.method) {
        case "getBalance": return ok({ context: { slot: 1 }, value: Math.round(o.sol * 1e9) });
        case "getTokenAccountsByOwner": {
          const prog = body.params[1].programId;
          const list = prog === T22 ? o.holdings.map((h) => ({ pubkey: `acct${h.token}`.padEnd(44, "1"), account: { lamports: h.lamports, data: { parsed: { info: { mint: mint(h.token), tokenAmount: { uiAmountString: String(h.amount), decimals: 6 } } } } } })) : [];
          return ok({ context: { slot: 1 }, value: list });
        }
        case "getSignaturesForAddress": return ok([...doc.trades.map((t) => ({ signature: t.tx, blockTime: Date.parse(t.time_aest) / 1000, err: null })), ...(o.unlogged ? [{ signature: SI_SIG, blockTime: 1790755161, err: null }, { signature: "Fai1ed".padEnd(88, "2"), blockTime: 1790755100, err: { InstructionError: [0, "x"] } }] : [])].reverse());
        case "getTransaction": return body.params[0] === SI_SIG ? ok(JSON.parse(fx("tx-si-buy.json")).result) : ok(null);
        default: return err(-32601, "not mocked");
      }
    }),
    target.route(/lite-api\.jup\.ag/, (route) => {
      if (preflight(route)) return;
      const u = new URL(route.request().url());
      if (u.pathname.startsWith("/price/")) {
        calls.push("jupiter-price");
        if (o.fail) return json(route, {}, 500);
        const ids = u.searchParams.get("ids").split(",");
        const out = {};
        for (const id of ids) {
          if (id === WSOL) out[id] = { usdPrice: 100 };
          for (const [k, px] of Object.entries(o.jupPrices || {})) if (id === mint(k)) out[id] = { usdPrice: px * 100, liquidity: 1234 };
        }
        return json(route, out);
      }
      calls.push("jupiter");
      if (o.fail) return json(route, {}, 500);
      const tokens = Object.fromEntries(o.holdings.map((h) => [mint(h.token), [{ account: `acct${h.token}`.padEnd(44, "1"), amount: String(h.amount * 1e6), uiAmount: h.amount, uiAmountString: String(h.amount), decimals: 6, programId: T22, lamports: String(h.lamports) }]]));
      return json(route, { amount: String(Math.round(o.sol * 1e9)), uiAmount: o.sol, uiAmountString: String(o.sol), tokens });
    }),
    target.route(/api\.dexscreener\.com/, (route) => {
      if (preflight(route)) return;
      calls.push("dex");
      if (o.fail) return json(route, {}, 500);
      if (o.dexEmpty) return json(route, []);
      const mints = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()).split(",");
      const pairs = [];
      for (const [k, px] of Object.entries(PRICES)) if (mints.includes(mint(k))) pairs.push({ baseToken: { address: mint(k), symbol: k }, quoteToken: { address: WSOL, symbol: "SOL" }, pairAddress: `pool${k}`.padEnd(44, "1"), dexId: "pumpswap", priceNative: String(px), priceUsd: String(px * 100), liquidity: { usd: 50000 }, volume: { h24: 1000 }, pairCreatedAt: 1790000000000 });
      return json(route, pairs);
    }),
    target.route(/api\.coinbase\.com|api\.coingecko\.com|binance\.vision|open\.er-api\.com/, (route) => {
      if (preflight(route)) return;
      calls.push(`fx ${new URL(route.request().url()).host}`);
      if (o.fail) return json(route, {}, 500);
      return json(route, { data: { currency: "SOL", rates: { USD: "100", AUD: "150" } } });
    }),
    target.route(/api\.geckoterminal\.com/, (route) => {
      if (preflight(route)) return;
      const u = route.request().url();
      calls.push(`gt ${u}`);
      if (o.fail) return json(route, {}, 429);
      if (u.includes(`pools/${`poolDDD`.padEnd(44, "1")}/`)) return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: fx("ohlcv-ddd.json") });
      return json(route, { data: { attributes: { ohlcv_list: [] } } });
    }),
  ]).then(() => calls);
}

async function openPage(browser, o) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: o.sw ? "allow" : "block", timezoneId: "Australia/Brisbane" });
  const page = await ctx.newPage();
  const consoleErrors = [], pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  if (o.now) await page.clock.setFixedTime(new Date(o.now));
  const calls = await mocks(o.sw ? ctx : page, o);
  await page.goto(BASE);
  await page.waitForSelector('body[data-ready="live"]', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-src="ohlcv"]') && !/…/.test(document.querySelector('[data-src="ohlcv"]').textContent), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  return { ctx, page, consoleErrors, pageErrors, calls };
}
const text = (page, sel) => page.$eval(sel, (e) => (e.innerText || e.textContent).replace(/\s+/g, " ").trim());
const attr = (page, sel, a) => page.$eval(sel, (e, a) => e.getAttribute(a), a);
const count = (page, sel) => page.$$eval(sel, (l) => l.length);
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(Number(a) - b) <= eps, `expected ${b}, got ${a}`);

const server = await start(PORT);
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });

// ---------------- Scenario A: normal, hand-computed ----------------
{
  const A = await openPage(browser, { fixture: "mock-a.json", now: "2026-10-07T13:00:00+10:00", sol: 1.488, holdings: [{ token: "DDD", amount: 100, lamports: 2000000 }], unlogged: true });
  const { page } = A;
  await page.screenshot({ path: path.join(SHOTS, "a-top.png") });
  await page.screenshot({ path: path.join(SHOTS, "a-full.png"), fullPage: true });
  await check("A header: total value, deposited, P&L in SOL / USD / AUD", async () => {
    assert.equal(await text(page, '[data-k="total-sol"]'), "1.6400 SOL");
    assert.equal(await text(page, '[data-k="total-usd"]'), "US$164.00");
    assert.equal(await text(page, '[data-k="total-aud"]'), "A$246.00");
    assert.equal(await text(page, '[data-k="deposited"]'), "1.5000 SOL");
    assert.equal(await text(page, '[data-k="pnl-sol"]'), "+0.1400");
    assert.equal(await text(page, '[data-k="pnl-pct"]'), "+9.3%");
    assert.equal(await text(page, '[data-k="pnl-usd"]'), "-US$46.00");
    assert.equal(await text(page, '[data-k="sol"]'), "1.4880");
    assert.equal(await text(page, '[data-k="tokens-value"]'), "0.1500");
    assert.equal(await text(page, '[data-k="rent"]'), "0.002000");
    assert.equal(await attr(page, '[data-k="gmgn"]', "href"), `https://gmgn.ai/sol/address/${W}`);
    assert.match(await text(page, '[data-k="updated"]'), /Live: 1:00:00 pm AEST/);
  });
  await check("A currency toggle SOL -> AUD -> USD", async () => {
    await page.click("#cur-toggle");
    assert.equal(await text(page, '[data-k="total"]'), "A$246.00");
    assert.match(await text(page, '[data-k="pnl"]'), /^-A\$69\.00 -21\.9%$/);
    assert.equal(await text(page, '[data-k="deposited"]'), "A$315.00");
    await page.click("#cur-toggle");
    assert.equal(await text(page, '[data-k="total"]'), "US$164.00");
    assert.match(await text(page, '[data-k="pnl"]'), /^-US\$46\.00 -21\.9%$/);
    await page.click("#cur-toggle");
    assert.equal(await text(page, '[data-k="total"]'), "1.6400 SOL");
  });
  await check("A unlogged live buy defaults to Me (inferred) and shows under Me immediately", async () => {
    assert.equal(await attr(page, '[data-trader="all"]', "aria-selected"), "true");
    await page.click('[data-trader="human"]');
    assert.equal(await attr(page, '[data-trader="human"]', "aria-selected"), "true");
    assert.equal(await count(page, "details.trade"), 3, "2 deposits + live SI buy");
    assert.equal(await attr(page, `details.trade[data-tx="${SI_SIG}"] .who`, "data-who"), "human");
    assert.equal(await attr(page, `details.trade[data-tx="${SI_SIG}"] .who`, "data-tsrc"), "inferred");
    assert.equal(await count(page, "#positions article.pos"), 1, "SI open under Me");
    assert.equal(await text(page, '[data-cmp="human-trades"]'), "1");
    assert.equal(await text(page, '[data-cmp="agent-trades"]'), "8");
    await page.click('[data-trader="agent"]');
  });
  await check("A open position DDD (Agent): cost, value, x, MFE/MAE, progress, hint", async () => {
    assert.equal(await count(page, "#positions article.pos"), 1);
    const c = '[data-pos="DDD"]';
    assert.equal(await text(page, `${c} [data-k="x"]`), "1.50x");
    assert.equal(await text(page, `${c} [data-k="cost"]`), "0.1000");
    assert.equal(await text(page, `${c} [data-k="value"]`), "0.1500");
    assert.equal(await text(page, `${c} [data-k="pnl"]`), "+0.0500 +50.0%");
    assert.equal(await text(page, `${c} [data-k="mfe"]`), "+60% / -30%");
    assert.equal(await attr(page, `${c} .prog`, "data-progress"), "50.00");
    assert.match(await text(page, `${c} [data-k="hint"]`), /1\.5x reached: rulebook says sell 1\/3/);
    assert.equal(await attr(page, `${c} [data-k="hint"]`, "class"), "hint amber");
    assert.equal(await count(page, `${c} .pm`), 4);
  });
  await check("A aggregates vs hand values", async () => {
    assert.equal(await text(page, '[data-k="win-rate"]'), "66.7%");
    assert.equal(await text(page, '[data-k="avg-win"]'), "+0.0650");
    assert.equal(await text(page, '[data-k="avg-loss"]'), "-0.0400");
    assert.equal(await text(page, '[data-k="pf"]'), "3.25");
    assert.equal(await text(page, '[data-k="expectancy"]'), "+0.0300 SOL");
    assert.equal(await text(page, '[data-k="maxdd"]'), "-0.0400 SOL");
    assert.equal(await text(page, '[data-k="streak"]'), "1 win");
    assert.equal(await text(page, '[data-k="fees"]'), "0.0110 SOL");
    const sub = (k) => page.$eval(`[data-k="${k}"]`, (e) => e.nextElementSibling.textContent);
    assert.match(await sub("avg-win"), /\+32\.5%/);
    assert.match(await sub("avg-loss"), /-40\.0%/);
    assert.match(await sub("expectancy"), /\+8\.3% · avg \+0\.24R/);
    assert.match(await sub("maxdd"), /on this group's P&L curve/);
    assert.match(await sub("maxdd"), /closed-only -0\.0400/);
    assert.match(await sub("streak"), /longest: 1 W \/ 1 L/);
    assert.match(await sub("fees"), /7\.9% of \|net P&L\|/);
    assert.ok((await count(page, "[data-few]")) >= 2, "too-few notes");
    const nTags = await count(page, "[data-n]"); assert.ok(nTags >= 11, `n = X tags: ${nTags}`);
  });
  await check("A per-position stats: hold, R, MFE/MAE, fees", async () => {
    const row = (t, k) => text(page, `#closed tr[data-position="${t}"] [data-k="${k}"]`);
    assert.equal(await row("AAA", "r"), "+1.43R");
    assert.equal(await row("BBB", "r"), "-1.14R");
    assert.equal(await row("CCC", "r"), "+0.43R");
    assert.equal(await row("DDD", "r"), "+1.43R");
    assert.equal(await row("BBB", "hold"), "27 h 0 m");
    assert.equal(await row("AAA", "hold"), "2 h 0 m");
    assert.equal(await row("CCC", "pct"), "+15.0%");
    assert.equal(await row("DDD", "mfe"), "+60%");
    assert.equal(await row("DDD", "mae"), "-30%");
    assert.equal(await row("AAA", "mfe"), "n/a");
    assert.equal(await row("CCC", "fees"), "0.004000");
  });
  await check("A All: wallet drawdown % and fees include the live Me row", async () => {
    await page.click('[data-trader="all"]');
    assert.match(await page.$eval('[data-k="maxdd"]', (e) => e.nextElementSibling.textContent), /-3\.6% of peak equity/);
    assert.equal(await text(page, '[data-k="fees"]'), "0.0119 SOL");
    assert.equal(await text(page, '[data-k="maxdd"]'), "-0.0400 SOL");
  });
  await check("A history filters (run / token / win-loss / action) + tx links + slippage", async () => {
    assert.equal(await count(page, "details.trade"), 11);
    await page.selectOption("#f-token", "CCC"); assert.equal(await count(page, "details.trade"), 3);
    await page.selectOption("#f-token", "all");
    await page.selectOption("#f-outcome", "loss"); assert.equal(await count(page, "details.trade"), 2);
    await page.selectOption("#f-outcome", "win"); assert.equal(await count(page, "details.trade"), 5);
    await page.selectOption("#f-outcome", "open"); assert.equal(await count(page, "details.trade"), 2);
    await page.selectOption("#f-outcome", "all");
    await page.selectOption("#f-run", "real"); assert.equal(await count(page, "details.trade"), 5);
    await page.selectOption("#f-run", "test"); assert.equal(await count(page, "details.trade"), 6);
    await page.selectOption("#f-run", "all");
    await page.selectOption("#f-action", "DEPOSIT"); assert.equal(await count(page, "details.trade"), 2);
    await page.selectOption("#f-action", "all");
    assert.match(await text(page, '[data-trade="saaa"] .stats-line'), /\+0\.1000 SOL \(\+50\.0%, \+1\.43R\) · hold 2 h 0 m .*slippage \+0\.99%/);
    assert.match(await text(page, '[data-trade="sccc2"] [data-k="leg-pnl"]'), /-0\.0200 SOL \(-20\.0%, -0\.57R\)/);
    await page.click('[data-trade="saaa"] summary');
    const href = await attr(page, '[data-trade="saaa"] [data-k="tx"]', "href");
    assert.equal(href, `https://solscan.io/tx/${"Mocksaaa".padEnd(88, "1")}`);
  });
  await check("A charts render (equity + drawdown, histogram, fees, per-token, calendar)", async () => {
    assert.ok((await count(page, 'svg[data-chart="equity"] path')) >= 3);
    assert.ok((await count(page, 'svg[data-chart="drawdown"] path')) >= 1);
    assert.ok((await count(page, 'svg[data-chart="fees"] path')) >= 1);
    assert.equal(await attr(page, 'svg[data-chart="histogram"] rect[data-bar="50"]', "data-value"), "2");
    assert.equal(await attr(page, 'svg[data-chart="histogram"] rect[data-bar="-50"]', "data-value"), "1");
    assert.equal(await attr(page, 'svg[data-chart="histogram"] rect[data-bar="0"]', "data-value"), "1");
    approx(await attr(page, 'rect[data-hbar="AAA"][data-kind="realized"]', "data-value"), 0.1);
    approx(await attr(page, 'rect[data-hbar="DDD"][data-kind="unrealized"]', "data-value"), 0.05);
    approx(await attr(page, 'rect[data-hbar="BBB"][data-kind="realized"]', "data-value"), -0.04);
    approx(await attr(page, 'rect[data-day="2026-09-28"]', "data-pnl"), 0.1);
    approx(await attr(page, 'rect[data-day="2026-09-30"]', "data-pnl"), -0.04);
    approx(await attr(page, 'rect[data-day="2026-10-07"]', "data-pnl"), 0.08);
    assert.ok(await page.$('[data-k="eq-approx"]'), "approximation note");
  });
  await check("A real-run rule panel + test-data preview", async () => {
    assert.equal(await attr(page, '[data-rule="buys"]', "data-level"), "amber");
    assert.match(await text(page, '[data-rule="buys"]'), /2\/2: daily buy limit reached/);
    assert.equal(await attr(page, '[data-rule="streak"]', "data-level"), "green");
    assert.equal(await attr(page, '[data-rule="weekly"]', "data-level"), "green");
    assert.match(await text(page, '[data-rule="weekly"]'), /\+16\.0% vs this week's top-up/);
    assert.match(await text(page, "#rules"), /Real run is live/);
    await page.check("#preview");
    assert.equal(await attr(page, '[data-rule="buys"]', "data-level"), "green");
    assert.equal(await attr(page, '[data-rule="streak"]', "data-level"), "amber");
    assert.equal(await attr(page, '[data-rule="weekly"]', "data-level"), "grey");
    await page.uncheck("#preview");
  });
  await check("A rule adherence (Agent): entry filters, exits, if-rules-followed", async () => {
    await page.click('[data-trader="agent"]');
    assert.equal(await text(page, '[data-k="entry-pass"]'), "50%");
    assert.equal(await text(page, '[data-k="exit-issues"]'), "2 late · 0 early");
    assert.equal(await text(page, '[data-k="if-rules"]'), "+0.0495 SOL");
    assert.match(await page.$eval('[data-k="if-rules"]', (e) => e.nextElementSibling.textContent), /vs actual \+0\.0500 SOL · 1\/4 lots simulated · approximate/);
    assert.match(await text(page, '[data-exit-note="BBB"]'), /late.*below the 0\.65x hard stop/i);
    assert.match(await text(page, '[data-exit-note="DDD"]'), /missed/i);
    assert.match(await text(page, 'tr[data-filter="liquidity_100k"]'), /Liquidity >= \$100k 2 1 1/);
  });
  await check("A breakdowns (token, hour, weekday, hold, liquidity, age, run)", async () => {
    for (const k of ["token", "hour", "dow", "hold", "liquidity", "age", "run"]) assert.ok(await page.$(`[data-bd="${k}"] tbody tr`), k);
    assert.match(await text(page, '[data-bd="run"] tr[data-row="test"]'), /^test 2 2 50% \+0\.0600 \+20\.0%$/);
    assert.match(await text(page, '[data-bd="run"] tr[data-row="real"]'), /^real 2 1 100% \+0\.0800 \+26\.7%$/);
    assert.match(await text(page, '[data-bd="hold"] tr[data-row="1-3 d"]'), /^1-3 d 1 1 0% -0\.0400/);
    assert.match(await text(page, '[data-bd="dow"] tr[data-row="Wed"]'), /^Wed 2 1 100%/);
    assert.match(await text(page, '[data-bd="liquidity"] tr[data-row="< $50k"]'), /^< \$50k 1 1 0%/);
    assert.match(await text(page, '[data-bd="age"] tr[data-row="12 h-3 d"]'), /^12 h-3 d 2 2 100% \+0\.1300/);
    assert.match(await text(page, '[data-bd="hour"] tr[data-row="20:00"]'), /^20:00 1 1 0%/);
    assert.match(await text(page, '[data-bd="trader"] tr[data-row="Agent"]'), /^Agent 4 3 67%/);
    await page.click('[data-trader="all"]');
  });
  await check("A unlogged on-chain activity detected and decoded (failed tx ignored)", async () => {
    assert.equal(await count(page, "[data-unlogged]"), 1);
    assert.match(await text(page, `[data-unlogged="${SI_SIG}"]`), /BUY 7Wh6rx… -0\.1016 SOL · 85,212\.77 tokens/);
    assert.equal(await attr(page, `[data-unlogged="${SI_SIG}"] .who`, "data-who"), "human");
  });
  await check("A rate-limit fallback: signatures fetched from the second RPC", async () => {
    assert.ok(A.calls.includes("rpc.solanatracker.io getSignaturesForAddress"), A.calls.join(", "));
    assert.ok(!A.calls.includes("jupiter"), "Jupiter not needed when RPC token accounts work");
    assert.ok(A.calls.some((c) => c.startsWith("gt ") && c.includes("currency=token")), "OHLCV requested in SOL terms");
  });
  await check("A scope switch to Real run", async () => {
    await page.click('[data-scope="real"]');
    assert.equal(await text(page, '[data-k="win-rate"]'), "100.0%");
    assert.equal(await attr(page, "#aggs .panel-head [data-n]", "data-n"), "1");
    await page.click('[data-scope="all"]');
  });
  await check("A no console errors / page errors", async () => {
    assert.deepEqual(A.pageErrors, []);
    assert.deepEqual(A.consoleErrors, []);
  });
  // Stale cache: next load 2 minutes later with every API down -> cached balances
  await check("E stale cache used when APIs fail later (same browser storage)", async () => {
    const p2 = await A.ctx.newPage();
    const errs = [];
    p2.on("pageerror", (e) => errs.push(e.message));
    await p2.clock.setFixedTime(new Date("2026-10-07T13:02:00+10:00"));
    await mocks(p2, { fixture: "mock-a.json", fail: true, sol: 0, holdings: [] });
    await p2.goto(BASE);
    await p2.waitForSelector('body[data-ready="live"]');
    await p2.waitForTimeout(500);
    assert.equal(await attr(p2, '[data-src="rpc"]', "class"), "chip amber");
    assert.match(await text(p2, '[data-alert="rpc"]'), /showing cached data/);
    assert.equal(await text(p2, '[data-k="total-sol"]'), "1.6400 SOL");
    assert.deepEqual(errs, []);
    await p2.close();
  });
  await A.ctx.close();
}

// ---------------- Scenario M: Me vs Agent (mock-c, hand-checked in tests/unit.mjs) ----------------
{
  const M = await openPage(browser, { fixture: "mock-c.json", now: "2026-10-07T13:00:00+10:00", sol: 0.92, holdings: [{ token: "ZZZ", amount: 100, lamports: 0 }, { token: "WWW", amount: 100, lamports: 0 }] });
  const { page } = M;
  await page.screenshot({ path: path.join(SHOTS, "m-compare.png"), fullPage: true });
  await check("M All: wallet P&L = Me + Agent; 9 rows; 2 open", async () => {
    assert.equal(await text(page, '[data-k="total-sol"]'), "1.1200 SOL");
    assert.equal(await text(page, '[data-k="pnl-sol"]'), "+0.1200");
    assert.equal(await count(page, "details.trade"), 9);
    assert.equal(await count(page, "#positions article.pos"), 2);
    assert.equal(await text(page, '[data-k="win-rate"]'), "66.7%");
  });
  await check("M toggle Me: every panel filters (header, positions, history, stats, breakdowns, closed table)", async () => {
    await page.click('[data-trader="human"]');
    assert.equal(await text(page, '[data-k="group-head"] [data-k="pnl-sol"]'), "0.0000");
    assert.equal(await text(page, '[data-k="g-realized"]'), "+0.0500");
    assert.equal(await text(page, '[data-k="g-unrealized"]'), "-0.0500");
    assert.equal(await text(page, '[data-k="g-fees"]'), "0.005000 SOL");
    assert.equal(await count(page, "details.trade"), 6);
    assert.deepEqual(await page.$$eval("details.trade", (l) => [...new Set(l.map((e) => e.dataset.trader))]), ["human"]);
    assert.equal(await count(page, "#positions article.pos"), 1); assert.ok(await page.$('[data-pos="WWW"]'));
    assert.equal(await text(page, '[data-k="win-rate"]'), "50.0%");
    assert.equal(await text(page, '[data-k="pf"]'), "2.00");
    assert.equal(await text(page, '[data-k="maxdd"]'), "-0.1000 SOL");
    assert.equal(await text(page, '[data-k="fees"]'), "0.005000 SOL");
    assert.deepEqual(await page.$$eval("#closed tr[data-position]", (l) => [...new Set(l.map((e) => e.dataset.trader))]), ["human"]);
    assert.equal(await count(page, '[data-bd="token"] tbody tr'), 3);
    assert.match(await text(page, '[data-rule="buys"]'), /3\/2: over the daily limit n = 3/, "Me: hxb, hyb, hwb today");
  });
  await check("M toggle Agent + persisted across reload", async () => {
    await page.click('[data-trader="agent"]');
    assert.equal(await text(page, '[data-k="group-head"] [data-k="pnl-sol"]'), "+0.1200");
    assert.equal(await count(page, "details.trade"), 3);
    assert.ok(await page.$('[data-pos="ZZZ"]')); assert.equal(await count(page, "#positions article.pos"), 1);
    assert.equal(await text(page, '[data-k="win-rate"]'), "100.0%");
    assert.equal(await text(page, '[data-k="maxdd"]'), "-0.0300 SOL");
    await page.reload(); await page.waitForSelector('body[data-ready="live"]'); await page.waitForTimeout(400);
    assert.equal(await attr(page, '[data-trader="agent"]', "aria-selected"), "true");
    assert.equal(await count(page, "details.trade"), 3);
    await page.click('[data-trader="all"]');
  });
  await check("M Me vs Agent panel: hand-checked numbers, AUD, equity overlay, n= and too-few notes", async () => {
    const v = (k) => text(page, `[data-cmp="${k}"]`);
    const sub = (k) => page.$eval(`[data-cmp="${k}"]`, (e) => e.nextElementSibling.textContent);
    assert.equal(await v("human-trades"), "5"); assert.equal(await v("agent-trades"), "3");
    assert.equal(await v("human-win-rate"), "50.0%"); assert.equal(await v("agent-win-rate"), "100.0%");
    assert.equal(await v("human-realized"), "+0.0500"); assert.equal(await sub("human-realized"), "+A$7.50");
    assert.equal(await v("agent-realized"), "+0.0700"); assert.equal(await sub("agent-realized"), "+A$10.50");
    assert.equal(await v("human-unrealized"), "-0.0500"); assert.match(await sub("human-unrealized"), /^-A\$7\.50/);
    assert.equal(await v("agent-unrealized"), "+0.0500"); assert.match(await sub("agent-unrealized"), /^\+A\$7\.50/);
    assert.equal(await v("human-pf"), "2.00"); assert.equal(await v("agent-pf"), "∞");
    assert.equal(await v("human-expectancy"), "+0.0250"); assert.equal(await v("agent-expectancy"), "+0.0700");
    assert.equal(await v("human-hold"), "30 m"); assert.equal(await v("agent-hold"), "1 h 30 m");
    assert.equal(await v("human-maxdd"), "-0.1000"); assert.equal(await v("agent-maxdd"), "-0.0300");
    assert.equal(await v("human-fees"), "0.005000"); assert.equal(await v("agent-fees"), "0.003000");
    assert.equal(await v("human-crossed"), "0"); assert.equal(await v("agent-crossed"), "1");
    assert.equal(await count(page, 'svg[data-chart="compare-equity"] path'), 2);
    assert.ok(await page.$('#compare [data-few="human"]')); assert.ok(await page.$('#compare [data-few="agent"]'));
    assert.equal(await count(page, "#compare [data-n]"), 2);
  });
  await check("M badges + crossed sell shown", async () => {
    assert.equal(await attr(page, '[data-trade="hxb"] .who', "data-tsrc"), "inferred");
    assert.match(await text(page, '[data-trade="hxb"] .who'), /Me ?\?/);
    assert.equal(await attr(page, '[data-trade="axb"] .who', "data-who"), "agent");
    assert.equal(await attr(page, '[data-trade="axb"] .who', "data-tsrc"), "logged");
    assert.match(await text(page, '[data-trade="hxs"] [data-k="crossed"]'), /500 from Agent's bag/);
    assert.ok(await page.$('#closed tr[data-position="XXX"][data-trader="agent"] .tag.crossed'));
    assert.match(await text(page, '[data-trade="hxs"] [data-k="leg-pnl"]'), /\+0\.2000 SOL/);
  });
  await check("M local override: Mark as Agent, persisted in ht-trader-overrides, export, reset", async () => {
    await page.click('[data-trade="hys"] summary');
    await page.click('[data-override-for="' + sig("hys") + '"] [data-mark="agent"]');
    assert.equal(await page.evaluate(() => localStorage.getItem("ht-trader-overrides")), JSON.stringify({ [sig("hys")]: "agent" }));
    assert.equal(await attr(page, '[data-trade="hys"]', "open"), "", "detail stays open");
    assert.equal(await attr(page, '[data-trade="hys"] summary .who', "data-who"), "agent");
    assert.equal(await attr(page, '[data-trade="hys"] summary .who', "data-tsrc"), "manual_override");
    assert.equal(await text(page, '[data-cmp="human-trades"]'), "4"); assert.equal(await text(page, '[data-cmp="agent-trades"]'), "4");
    assert.equal(await text(page, '[data-cmp="human-crossed"]'), "1");
    const json = JSON.parse(await page.$eval('[data-k="overrides-json"]', (e) => e.value));
    assert.deepEqual(json.overrides, [{ tx: sig("hys"), trader: "agent", id: "hys", was: "human" }]);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-overrides")]);
    assert.equal(dl.suggestedFilename(), "hades-trader-overrides.json");
    const body = JSON.parse(fs.readFileSync(await dl.path(), "utf8")); assert.equal(body.overrides[0].trader, "agent"); assert.equal(body.schema, "ht-trader-overrides/1");
    await page.reload(); await page.waitForSelector('body[data-ready="live"]'); await page.waitForTimeout(400);
    assert.equal(await attr(page, '[data-trade="hys"] summary .who', "data-who"), "agent", "persisted after reload");
    await page.click('[data-trade="hys"] summary');
    await page.click('[data-override-for="' + sig("hys") + '"] [data-mark="reset"]');
    assert.equal(await page.evaluate(() => localStorage.getItem("ht-trader-overrides")), "{}");
    assert.equal(await text(page, '[data-cmp="human-trades"]'), "5");
    await page.click('[data-override-for="' + sig("hys") + '"] [data-mark="human"]').catch(() => {}); // disabled: no-op
    assert.equal(await page.evaluate(() => localStorage.getItem("ht-trader-overrides")), "{}");
  });
  await check("M no console errors / page errors", async () => { assert.deepEqual(M.pageErrors, []); assert.deepEqual(M.consoleErrors, []); });
  await M.ctx.close();
}

// ---------------- Scenario B: Jupiter fallback + all-red limits ----------------
{
  const B = await openPage(browser, { fixture: "mock-b.json", now: "2026-10-08T15:00:00+10:00", sol: 0.061, holdings: [{ token: "GGG", amount: 100, lamports: 2039280 }], noIndexed: true, dexEmpty: true, jupPrices: { EEE: 0.0001, FFF: 0.0001, GGG: 0.0003 } });
  const { page } = B;
  await page.screenshot({ path: path.join(SHOTS, "b-rules.png"), fullPage: true });
  await check("B token balances fall back to Jupiter when RPCs refuse indexed calls", async () => {
    assert.ok(B.calls.includes("jupiter"));
    assert.match(await attr(page, '[data-src="rpc"]', "title"), /Jupiter holdings API/);
    assert.equal(await text(page, '[data-k="total-sol"]'), "0.0930 SOL");
    assert.equal(await text(page, '[data-k="pnl-sol"]'), "-0.1070");
  });
  await check("B prices fall back to Jupiter when DexScreener has no pair", async () => {
    assert.ok(B.calls.includes("jupiter-price"));
    assert.match(await attr(page, '[data-src="dex"]', "title"), /3\/3 priced; 3 via Jupiter/);
    assert.equal(await text(page, '[data-pos="GGG"] [data-k="x"]'), "0.60x");
  });
  await check("B rule panel all red (3 buys, 2 losses -> pause, -54.5% week)", async () => {
    for (const k of ["buys", "streak", "weekly"]) assert.equal(await attr(page, `[data-rule="${k}"]`, "data-level"), "red", k);
    assert.match(await text(page, '[data-rule="streak"]'), /pause until 9 Oct(ober)?, 1:00 pm AEST/);
    assert.match(await text(page, '[data-rule="weekly"]'), /Down 50%\+/);
    assert.match(await text(page, '[data-pos="GGG"] [data-k="hint"]'), /Below the -35% hard stop/);
    assert.equal(await text(page, '[data-k="streak"]'), "2 losses");
  });
  await check("B no console errors", async () => { assert.deepEqual(B.pageErrors, []); assert.deepEqual(B.consoleErrors, []); });
  await B.ctx.close();
}

// ---------------- Scenario C: every API down ----------------
{
  const C = await openPage(browser, { fixture: "mock-a.json", now: "2026-10-07T13:00:00+10:00", fail: true, sol: 0, holdings: [] });
  const { page } = C;
  await page.screenshot({ path: path.join(SHOTS, "c-failures.png"), fullPage: false });
  await check("C API failure states: estimated value, alerts, red chips, n/a", async () => {
    assert.ok(await page.$('[data-k="estimated"]'));
    assert.equal(await text(page, '[data-k="total-sol"]'), "1.5900 SOL");
    assert.equal(await text(page, '[data-k="total-usd"]'), "n/a");
    assert.ok(await page.$('[data-alert="rpc"]'));
    assert.ok(await page.$('[data-alert="dex"]'));
    assert.ok(await page.$('[data-k="fx-error"]'));
    assert.equal(await attr(page, '[data-src="rpc"]', "data-ok"), "0");
    assert.equal(await attr(page, '[data-src="dex"]', "data-ok"), "0");
    assert.equal(await attr(page, '[data-src="fx"]', "data-ok"), "0");
    assert.equal(await text(page, '[data-pos="DDD"] [data-k="value"]'), "n/a");
    assert.match(await text(page, '[data-pos="DDD"] [data-k="hint"]'), /No live price/);
    assert.equal(await text(page, '[data-k="if-rules"]'), "n/a");
    assert.equal(await text(page, '[data-k="win-rate"]'), "66.7%");
  });
  await check("C only network-level console errors, no JS errors", async () => {
    assert.deepEqual(C.pageErrors, []);
    const other = C.consoleErrors.filter((m) => !/Failed to load resource/.test(m));
    assert.deepEqual(other, []);
  });
  await C.ctx.close();
}

// ---------------- Scenario D: PWA / service worker ----------------
{
  const D = await openPage(browser, { fixture: "mock-a.json", now: "2026-10-07T13:00:00+10:00", sol: 1.488, holdings: [{ token: "DDD", amount: 100, lamports: 2000000 }], sw: true });
  const { page } = D;
  await check("D manifest id/scope and service worker scope /hades-trades/, never caches API calls", async () => {
    const man = await page.evaluate(() => fetch("manifest.webmanifest").then((r) => r.json()));
    assert.equal(man.id, "/hades-trades/"); assert.equal(man.scope, "/hades-trades/");
    const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
    assert.equal(scope, BASE);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('body[data-ready="live"]');
    await page.waitForTimeout(1500);
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    assert.ok(controlled, "page controlled by SW after reload");
    const urls = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) out.push(r.url); } return out; });
    assert.ok(urls.length > 5, "shell cached");
    const foreign = urls.filter((u) => !u.startsWith(BASE));
    assert.deepEqual(foreign, []);
    assert.equal(await text(page, '[data-k="total-sol"]'), "1.6400 SOL");
  });
  await check("D no console errors with the service worker", async () => { assert.deepEqual(D.pageErrors, []); assert.deepEqual(D.consoleErrors, []); });
  await D.ctx.close();
}
// Service worker must register before (and independent of) data loading.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, serviceWorkers: "allow", timezoneId: "Australia/Brisbane" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await mocks(ctx, { fixture: "mock-c.json", sol: 0.92, holdings: [], slowData: 6000 });
  await page.goto(BASE);
  await check("D2 service worker registers first, while trades.json is still loading", async () => {
    const r = await page.evaluate(async () => { for (let i = 0; i < 40; i++) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) return { reg: true, ready: document.body.dataset.ready || null }; await new Promise((res) => setTimeout(res, 100)); } return { reg: false }; });
    assert.equal(r.reg, true); assert.equal(r.ready, null, "data not loaded yet");
    await page.waitForSelector('body[data-ready="live"]', { timeout: 20000 });
    assert.deepEqual(errs, []);
  });
  await ctx.close();
}

await browser.close();
server.close();
fs.writeFileSync(path.join(SHOTS, "e2e-results.txt"), results.join("\n") + "\n");
console.log(`\n${passed}/${results.length} e2e checks passed`);
