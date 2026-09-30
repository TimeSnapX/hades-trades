// Tiny static server: serves the repo at /hades-trades/ (like GitHub Pages).
//   node tests/server.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
export function start(port = 4731, { dataFile } = {}) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (!u.pathname.startsWith("/hades-trades/")) { res.writeHead(404); return res.end("not found"); }
    let rel = decodeURIComponent(u.pathname.slice("/hades-trades/".length)) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    let file = path.join(root, rel);
    if (dataFile && rel === "data/trades.json") file = dataFile;
    if (!file.startsWith(root) && file !== dataFile) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(buf);
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 4731);
  await start(port);
  console.log(`serving ${root} at http://127.0.0.1:${port}/hades-trades/`);
}
