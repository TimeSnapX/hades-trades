// Render icons/*.png from favicon.svg with headless Chrome (playwright-core).
import { createRequire } from "node:module";
import fs from "node:fs";
const req = createRequire(process.env.PLAYWRIGHT_DIR ? process.env.PLAYWRIGHT_DIR + "/package.json" : "/usr/local/lib/node_modules/package.json");
const { chromium } = req("playwright-core");
const svg = fs.readFileSync(new URL("../favicon.svg", import.meta.url), "utf8");
const b = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
const p = await b.newPage();
for (const [name, size, pad] of [["icon-192.png", 192, 0], ["icon-512.png", 512, 0], ["icon-maskable-512.png", 512, 0.12], ["apple-touch-icon.png", 180, 0.08]]) {
  await p.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - 2 * pad));
  await p.setContent(`<html><body style="margin:0;background:#0b0c0a;display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</body></html>`);
  await p.screenshot({ path: new URL(`../icons/${name}`, import.meta.url).pathname, omitBackground: false });
}
await b.close();
console.log("icons written");
