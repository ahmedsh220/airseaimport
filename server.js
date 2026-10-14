// Serves the dashboard and proxies the products API so the browser avoids CORS.
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const http2 = require("http2");
const fs = require("fs");
const path = require("path");

// Local runs read settings from .env (Render sets them in the dashboard instead). See .env.example.
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {}
const auth = require("./lib/auth");
const catalog = require("./lib/catalog");
const competitors = require("./lib/competitors");
const excel = require("./lib/excel");
const tiktokSales = require("./lib/tiktok-sales");

const PORT = process.env.PORT || 3000;
const API = process.env.PRODUCTS_API || "https://hub.fragrancewholesalerusa.com/api/open/products";
const CACHE_MS = 5 * 60 * 1000; // the upstream is slow and sometimes cuts off; don't hit it more than needed
const PUBLIC = path.join(__dirname, "public");
// Every image (logos, icon) lives in media/ and is served at /media/.
const MEDIA = path.join(__dirname, "media");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

let cache = { at: 0, body: null, stale: false };
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
function getOnce(gzip) {
  return new Promise((resolve, reject) => {
    const headers = { ...HEADERS, "accept-encoding": gzip ? "gzip, deflate" : "identity", connection: "close" };
    const req = (API.startsWith("https:") ? https : http).get(API, { headers, timeout: 45000 }, res => {
      console.log(`Upstream responded ${res.statusCode}; CORS header: ${res.headers["access-control-allow-origin"] || "none"}; cf-cache: ${res.headers["cf-cache-status"] || "-"}`);
      let raw = 0;
      res.on("data", c => { raw += c.length; });
      const info = () => `status ${res.statusCode}, ${raw} bytes received of ${res.headers["content-length"] || "unknown"}, encoding ${res.headers["content-encoding"] || "none"}, server ${res.headers.server || "?"}`;
      const enc = res.headers["content-encoding"];
      const stream = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("error", e => reject(new Error(`${e.message} (${info()})`)));
      res.on("aborted", () => {
        // Show where the API stopped so the record it chokes on can be found.
        if (!res.headers["content-encoding"]) console.warn(`Cut-off tail: ${Buffer.concat(chunks).toString("utf8").slice(-400)}`);
        reject(new Error(`upstream closed the connection mid-response (${info()})`));
      });
      res.on("error", e => reject(new Error(`${e.message} (${info()})`)));
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

// Browsers reach the API over HTTP/2, and that works; our HTTP/1.1 requests get cut off by
// Cloudflare partway through. So ask over HTTP/2 like a browser does.
function getH2() {
  return new Promise((resolve, reject) => {
    const u = new URL(API);
    const client = http2.connect(u.origin);
    const fail = e => { client.close(); reject(e); };
    client.on("error", fail);
    const req = client.request({ ":path": u.pathname + u.search, ...HEADERS, "accept-encoding": "gzip" });
    req.setTimeout(60000, () => { req.close(); fail(new Error("HTTP/2 request timed out after 60s")); });
    let head = {};
    req.on("response", h => { head = h; });
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("error", fail);
    req.on("end", () => {
      client.close();
      try {
        let buf = Buffer.concat(chunks);
        if (head["content-encoding"] === "gzip") buf = zlib.gunzipSync(buf);
        const body = buf.toString("utf8");
        if (head[":status"] !== 200) return reject(new Error(`Upstream HTTP/2 ${head[":status"]}: ${body.slice(0, 200)}`));
        JSON.parse(body);
        console.log(`HTTP/2 ok; CORS header: ${head["access-control-allow-origin"] || "none"}`);
        resolve(body);
      } catch (e) { reject(new Error(`HTTP/2 response unusable: ${e.message} (${chunks.reduce((a, c) => a + c.length, 0)} bytes)`)); }
    });
  });
}

async function fetchUpstream() {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Alternate gzip and plain transfers in case one of them is what the upstream trips on.
      const t = Date.now(), body = API.startsWith("https:") && attempt === 1 ? await getH2() : await getOnce(attempt % 2 === 1);
      console.log(`Products fetched in ${Date.now() - t}ms (${body.length} bytes, attempt ${attempt})`);
      return body;
    } catch (e) {
      last = e;
      console.warn(`Products fetch attempt ${attempt} failed: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
      if (attempt < 3) await sleep(attempt * 1500);
    }
  }
  throw last;
}

// Share one upstream call between concurrent requests.
function refresh() {
  return inflight ||= fetchUpstream().then(body => { cache = { at: Date.now(), body, stale: false }; })
    .catch(e => { if (cache.body) cache.stale = true; console.warn(`Products refresh failed: ${e.message}`); throw e; })
    .finally(() => { inflight = null; });
}

// Once a copy is in memory, pages never wait on the upstream API: an old copy is served right away
// while a fresh one loads in the background. Only the very first load after a restart waits.
async function products(force) {
  if (cache.body && !force) {
    if (Date.now() - cache.at >= CACHE_MS) refresh().catch(() => {});
    return cache.body;
  }
  try { await refresh(); }
  catch (e) { if (!cache.body) throw e; }
  return cache.body;
}

async function productList() {
  const d = JSON.parse(await products());
  return Array.isArray(d) ? d : (d.data || d.products || d.items || []);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (await auth.gate(req, res, url)) return;
  if (url.pathname === "/api/products") {
    try {
      const body = await products(url.searchParams.has("refresh"));
      res.writeHead(200, { "content-type": "application/json", "x-fetched-at": new Date(cache.at).toISOString(),
        "x-source": cache.stale ? "stale" : "live", "access-control-expose-headers": "x-fetched-at, x-source" });
      res.end(body);
    } catch (e) {
      console.error(`/api/products failed: ${e.message}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const catalogMeta = () => ({ fetchedAt: new Date(cache.at).toISOString() });
  if (await catalog.handle(req, res, url, productList, catalogMeta)) return;
  if (await catalog.handleAdmin(req, res, url, productList, catalogMeta)) return;
  if (await competitors.handle(req, res, url, productList)) return;
  if (await excel.handle(req, res, url)) return;
  if (await tiktokSales.handle(req, res, url)) return;
  if (url.pathname === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  const route = { "/": "/index.html", "/favicon.ico": "/media/favicon.svg" }[url.pathname] || url.pathname;
  const media = route.startsWith("/media/"), root = media ? MEDIA : PUBLIC;
  const file = path.join(root, path.normalize(media ? route.slice(6) : route));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    // no-cache: browsers check for a new version on every load, so a deploy shows up on the next refresh.
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": media ? "public, max-age=86400" : "no-cache" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Dashboard on :${PORT}`);
  // Warm the cache at boot so the first visitor after a restart doesn't wait on the upstream API.
  products(true).then(() => console.log("Products cache warmed"), e => console.warn(`Warm-up failed: ${e.message}`));
  competitors.schedule(productList);
  // Keep trying in the background so a good copy is ready whenever the API answers in full.
  setInterval(() => {
    if (Date.now() - cache.at > CACHE_MS) refresh().catch(() => {});
  }, 2 * 60 * 1000).unref();
});
