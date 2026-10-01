/*
 * Hades Trades service worker: installable + opens offline. Deliberately small:
 * - Scope /hades-trades/. Only same-origin GET requests inside the scope are
 *   handled. Every API call (Solana RPC, Jupiter, DexScreener, GeckoTerminal,
 *   CoinGecko, Coinbase, Binance, ExchangeRate-API, fonts) is cross-origin and
 *   is never intercepted and never cached.
 * - Network first, so online behaviour is unchanged; the cache is only an
 *   offline fallback. data/trades.json is always fetched fresh when online.
 * Bump VERSION to drop old caches.
 */
const VERSION = "v3";
const CACHE = `hades-trades-${VERSION}`;
const SCOPE = new URL(self.registration.scope);
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "favicon.svg",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png",
  "css/app.css?v=2", "js/app.js?v=3", "js/stats.js?v=3", "js/schema.js?v=3", "js/parse-tx.js?v=3", "js/sources.js?v=3", "js/charts.js?v=3",
  "data/trades.json",
];

function handled(request) {
  if (request.method !== "GET") return false;
  if (request.headers.has("range")) return false;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return false; // all APIs are cross-origin: never touched
  if (!url.pathname.startsWith(SCOPE.pathname)) return false;
  if (url.pathname === `${SCOPE.pathname}sw.js`) return false;
  return true;
}
const isPage = (r) => r.mode === "navigate" || (r.headers.get("accept") || "").includes("text/html");
function cacheKey(request) {
  const url = new URL(request.url);
  url.hash = "";
  if (isPage(request) || url.pathname.endsWith("/data/trades.json")) url.search = "";
  return url.href;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(SHELL.map((p) => {
      const u = new URL(p, SCOPE).href;
      return fetch(new Request(u, { cache: "reload" })).then((res) => (res.ok ? cache.put(u.replace(/\?t=\d+$/, ""), res) : null)).catch(() => null);
    }))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("hades-trades-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!handled(request)) return;
  const key = cacheKey(request);
  event.respondWith(
    fetch(request).then((res) => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}));
      }
      return res;
    }).catch(async () => {
      const cache = await caches.open(CACHE);
      const hit = (await cache.match(key)) || (await cache.match(request.url, { ignoreSearch: true }));
      if (hit) return hit;
      if (isPage(request)) {
        const shell = (await cache.match(SCOPE.href)) || (await cache.match(new URL("index.html", SCOPE).href));
        if (shell) return shell;
      }
      return Response.error();
    }),
  );
});
