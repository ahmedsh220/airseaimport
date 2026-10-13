// Serves the dashboard and proxies the products API so the browser avoids CORS.
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API = process.env.PRODUCTS_API || "https://hub.fragrancewholesalerusa.com/api/open/products";
const CACHE_MS = 60 * 1000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

let cache = { at: 0, body: null };
let inflight = null;

// Some upstream protection rejects bare server requests, so look like a normal browser call.
const HEADERS = {
  accept: "application/json, text/plain, */*",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  "accept-language": "en-US,en;q=0.9",
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Plain https + gzip instead of fetch: the upstream sometimes drops the connection mid-body
// ("terminated"), and a compressed transfer is ~4x smaller, so it finishes before that happens.
function getOnce() {
  return new Promise((resolve, reject) => {
    const req = (API.startsWith("https:") ? https : http).get(API, { headers: { ...HEADERS, "accept-encoding": "gzip, deflate", connection: "close" }, timeout: 45000 }, res => {
      const enc = res.headers["content-encoding"];
      const stream = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("error", reject);
      res.on("aborted", () => reject(new Error("upstream closed the connection mid-response")));
      stream.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`Upstream HTTP ${res.statusCode}: ${body.slice(0, 200).replace(/\s+/g, " ")}`));
        try { JSON.parse(body); resolve(body); } // don't cache a broken or cut-off response
        catch { reject(new Error(`Upstream sent incomplete JSON (${body.length} bytes)`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Upstream timed out after 45s")));
    req.on("error", reject);
  });
}

async function fetchUpstream() {
  let last;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const t = Date.now(), body = await getOnce();
      console.log(`Products fetched in ${Date.now() - t}ms (${body.length} bytes, attempt ${attempt})`);
      return body;
    } catch (e) {
      last = e;
      console.warn(`Products fetch attempt ${attempt} failed: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
      if (attempt < 6) await sleep(attempt * 1500);
    }
  }
  throw last;
}

async function products(force) {
  if (!force && cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  // Share one upstream call between concurrent requests.
  inflight ||= fetchUpstream().then(body => { cache = { at: Date.now(), body }; }).finally(() => { inflight = null; });
  try {
    await inflight;
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
      console.error(`/api/products failed: ${e.message}`);
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
}).listen(PORT, () => {
  console.log(`Dashboard on :${PORT}`);
  // Warm the cache at boot so the first visitor after a restart doesn't wait on the upstream API.
  products(true).then(() => console.log("Products cache warmed"), e => console.warn(`Warm-up failed: ${e.message}`));
});
