// Live-API smoke test (no mocks): real trades.json, public RPC, Jupiter, DexScreener,
// GeckoTerminal, Coinbase/CoinGecko. Phone viewport, normal mobile Chrome UA.
//   node tests/live-smoke.mjs [url]     default: local server on :4733
// Fails on any JavaScript error. Third-party network failures (rate limits, CORS
// on 429 responses) are listed separately: the app is expected to degrade, not break.
import { createRequire } from "node:module";
import path from "node:path";
import { start } from "./server.mjs";
const req = createRequire(path.join(process.env.PLAYWRIGHT_DIR || "/usr/local/lib/node_modules", "package.json"));
const { chromium } = req("playwright-core");
let url = process.argv[2], server;
if (!url) { server = await start(4733); url = "http://127.0.0.1:4733/hades-trades/"; }
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const b = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, userAgent: UA, serviceWorkers: process.env.SW ? "allow" : "block" });
const p = await ctx.newPage();
const appErrors = [], netErrors = [];
p.on("pageerror", (e) => appErrors.push(e.message));
p.on("console", (m) => { if (m.type() !== "error") return; const t = m.text(); (/Failed to load resource|blocked by CORS policy|net::ERR_/.test(t) ? netErrors : appErrors).push(t.slice(0, 200)); });
p.on("response", (r) => { if (r.status() >= 400) netErrors.push(`HTTP ${r.status()} ${r.url().slice(0, 110)}`); });
await p.goto(url);
await p.waitForSelector('body[data-ready="live"]', { timeout: 45000 });
await p.waitForTimeout(Number(process.env.WAIT || 12000));
const q = (s) => p.$eval(s, (e) => e.innerText.replace(/\s+/g, " ").trim()).catch(() => null);
const chips = await p.$$eval("[data-src]", (l) => l.map((e) => `${e.textContent} (${e.title})`));
const out = {
  url,
  total: await q('[data-k="total-sol"]'), usd: await q('[data-k="total-usd"]'), aud: await q('[data-k="total-aud"]'),
  deposited: await q('[data-k="deposited"]'), pnl: await q('[data-k="pnl-sol"]') + " " + (await q('[data-k="pnl-pct"]')),
  positions: await p.$$eval("#positions article.pos", (l) => l.map((e) => e.querySelector("b").textContent + " " + e.querySelector('[data-k="x"]').textContent)),
  unlogged: await p.$$eval("[data-unlogged]", (l) => l.map((e) => e.innerText.replace(/\s+/g, " "))),
  charts: await p.$$eval("svg[data-chart]", (l) => l.map((e) => e.dataset.chart)),
  compare: await p.$$eval("#compare [data-cmp]", (l) => Object.fromEntries(l.map((e) => [e.dataset.cmp, e.textContent.trim() + (e.nextElementSibling ? " (" + e.nextElementSibling.textContent.trim() + ")" : "")]))),
  badges: await p.$$eval("details.trade .who", (l) => l.reduce((m, e) => { const k = e.dataset.who + "/" + e.dataset.tsrc; m[k] = (m[k] || 0) + 1; return m; }, {})),
  traderSeg: await p.$$eval("[data-trader]", (l) => l.filter((e) => e.tagName === "BUTTON").map((e) => e.dataset.trader)),
  swRegistered: process.env.SW ? await p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())) : "blocked",
  chips, appErrors, netErrors,
};
await p.screenshot({ path: process.env.SHOT || "/tmp/hades-live.png", fullPage: false });
console.log(JSON.stringify(out, null, 2));
await b.close(); if (server) server.close();
// Open positions: the page must list exactly as many as the Me/Agent panel counts
// ("· N open"); zero open positions is a valid state (everything sold).
const openOf = (k) => { const m = /(\d+) open/.exec(out.compare[k] || ""); return m ? Number(m[1]) : null; };
const nOpen = [openOf("human-unrealized"), openOf("agent-unrealized")];
const positionsOk = nOpen.every((v) => v != null) && out.positions.length === nOpen[0] + nOpen[1];
// Drawdown sanity: a group's max drawdown can't exceed the SOL ever deposited.
const solNum = (s) => { const m = /-?[\d.]+/.exec((s || "").replace(/[−–]/g, "-")); return m ? Number(m[0]) : NaN; };
const dep = solNum(out.deposited);
const ddOk = ["human-maxdd", "agent-maxdd"].every((k) => Math.abs(solNum(out.compare[k])) <= dep + 1e-9);
const checks = { appErrors: appErrors.length === 0, total: /SOL$/.test(out.total || ""), positions: positionsOk, charts: out.charts.length >= 6, compare: Object.keys(out.compare).length >= 20, traderSeg: out.traderSeg.length === 3, drawdown: ddOk };
console.log("checks", JSON.stringify({ ...checks, open: nOpen, deposited: dep }));
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "LIVE SMOKE OK" : "LIVE SMOKE FAILED");
process.exit(ok ? 0 : 1);
