// Serves the dashboard and proxies the products API so the browser avoids CORS.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API = process.env.PRODUCTS_API || "https://hub.fragrancewholesalerusa.com/api/open/products";
const CACHE_MS = 60 * 1000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

let cache = { at: 0, body: null };

async function products(force) {
  if (!force && cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  try {
    const res = await fetch(API, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
    const body = await res.text();
    JSON.parse(body); // don't cache a broken response
    cache = { at: Date.now(), body };
  } catch (e) {
    // Upstream down or slow: serve the last good copy rather than failing the page.
    if (!cache.body) throw e;
    console.warn(`Serving cached products from ${new Date(cache.at).toISOString()}: ${e.message}`);
  }
  return cache.body;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/products") {
    try {
      const body = await products(url.searchParams.has("refresh"));
      res.writeHead(200, { "content-type": "application/json", "x-fetched-at": new Date(cache.at).toISOString() });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  const route = { "/": "/index.html", "/favicon.ico": "/favicon.svg" }[url.pathname] || url.pathname;
  const file = path.join(PUBLIC, path.normalize(route));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Dashboard on :${PORT}`));
