// TikTok Shop competitor prices from Euka's OpenAPI (https://server.euka.ai/docs).
// For every SKU in the products API we search Euka's marketplace-wide product index by name,
// score each result against our product (name words + size), keep the best N, and save the
// result to disk. The dashboard reads it from /api/competitors.
const fs = require("fs");
const path = require("path");

const env = (k, d) => (process.env[k] ?? "").trim() || d;
const CFG = {
  key: env("EUKA_API_KEY", ""),
  base: env("EUKA_API_BASE", "https://server.euka.ai/api/v1").replace(/\/+$/, ""),
  searchPath: env("EUKA_PRODUCT_SEARCH_PATH", "/social-intelligence/products"),
  region: env("EUKA_REGION", "US"),
  perSku: +env("COMPETITORS_PER_SKU", "5"),
  refreshHours: +env("COMPETITOR_REFRESH_HOURS", "12"),
  concurrency: Math.max(1, +env("EUKA_CONCURRENCY", "3")),
  delayMs: +env("EUKA_DELAY_MS", "250"),
  minScore: +env("COMPETITOR_MIN_SCORE", "0.6"),
  ourShops: env("OUR_TIKTOK_SHOP_NAMES", "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  adminToken: env("ADMIN_TOKEN", ""),
  dataDir: env("COMPETITOR_DATA_DIR", path.join(__dirname, "data")),
};
const FILE = path.join(CFG.dataDir, "competitors.json");
const OVERRIDES = path.join(CFG.dataDir, "competitor-overrides.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Euka client ----------
async function euka(p, params = {}, attempt = 1) {
  const u = new URL(CFG.base + p);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, x)); else u.searchParams.set(k, v);
  }
  let res;
  try {
    res = await fetch(u, { headers: { authorization: `Bearer ${CFG.key}`, accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    if (attempt < 4) { await sleep(attempt * 2000); return euka(p, params, attempt + 1); }
    throw new Error(`Euka unreachable: ${e.message}`);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) {
      const wait = (+res.headers.get("retry-after") || attempt * 3) * 1000;
      await sleep(Math.min(wait, 60000));
      return euka(p, params, attempt + 1);
    }
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Euka HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// ---------- matching ----------
// Words that describe the format, not the product, so they're useless for search.
const STOP = new Set(("by edp edt edc eau de parfum perfume toilette cologne spray fl oz ml for women men unisex " +
  "the and a of with new limited edition concentrated oil extrait pour homme femme natural vaporisateur " +
  "body mist roll on rollon parfums fragrance fragrances ladies mens womens gift set").split(" "));
const norm = s => String(s || "").toLowerCase().replace(/[*™®]/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
const words = s => norm(s).split(" ").map(w => w.replace(/^\.+|\.+$/g, "")).filter(w => w && !STOP.has(w) && !/^\d[\d.]*$/.test(w) && !/^\d[\d.]*(fl|oz|ml|g)/.test(w) && !/^[.]+$/.test(w));

// Sizes in a title, as millilitres: "3.4FL.OZ", "3.4 oz", "100ML", "100 ml".
function sizes(s) {
  const t = String(s || "").toLowerCase(), out = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*-?\s*ml\b/g)) out.push(+m[1]);
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*-?\s*(?:fl\.?\s*)?oz\b/g)) out.push(+m[1] * 29.5735);
  return out.filter(x => x > 0 && x < 2000);
}
const sameSize = (a, b) => Math.abs(a - b) <= Math.max(3, a * 0.06);

function profile(p) {
  const name = String(p.name || "").split("|")[0];
  return { sku: p.sku, name: p.name, words: [...new Set(words(name))], sizes: sizes(p.name) };
}

// Search terms from most to least specific. Euka's `query` is a name/title search, so a long
// phrase can miss when a seller words the title differently; shorter fallbacks catch those.
function queries(pr) {
  const w = pr.words, out = [];
  if (w.length) out.push(w.slice(0, 6).join(" "));
  if (w.length > 2) out.push(w.slice(-2).join(" "));          // the scent name usually comes last
  if (w.length > 3) out.push(w.slice(-3).join(" "));
  if (w.length > 2) out.push(w.slice(0, 2).join(" ") + " " + w[w.length - 1]);
  return [...new Set(out.map(q => q.slice(0, 100)).filter(q => q.length >= 2))];
}

// 0..1: share of our product's words found in the title, with a size bonus or penalty.
function score(pr, item) {
  const title = norm(item.title);
  const tw = new Set(title.split(" ").map(w => w.replace(/^\.+|\.+$/g, "")));
  if (!pr.words.length) return 0;
  const hit = pr.words.filter(w => tw.has(w) || (w.length > 4 && title.includes(w))).length;
  let s = hit / pr.words.length;
  const ts = sizes(item.title);
  // A different size is a different item, so it can only show up as a near miss.
  if (pr.sizes.length && ts.length) s = ts.some(a => pr.sizes.some(b => sameSize(a, b))) ? s + 0.15 : Math.min(s, 0.45);
  if (/\b(sample|decant|vial|tester|travel size|mini)\b/.test(title) && !/\b(sample|decant|vial|tester|mini)\b/.test(norm(pr.name))) s -= 0.3;
  if (/\b(set|bundle|pack of|\d+ ?pc|\d+ ?pcs|duo|trio)\b/.test(title) && !/\b(set|pack|pc|pcs)\b/.test(norm(pr.name))) s -= 0.15;
  return Math.max(0, Math.min(1, s));
}

const productUrl = id => `https://www.tiktok.com/view/product/${encodeURIComponent(id)}`;
function slim(item, s) {
  return {
    id: String(item.id), title: item.title, shop: item.brand?.name || null, shopId: item.brandId || item.brand?.id || null,
    price: item.price?.current ?? null, original: item.price?.original ?? null, shipping: item.price?.shipping ?? null,
    currency: item.currencyCode || "USD", sold: item.soldCount ?? null, sold30: item.last30dSoldCount ?? null,
    gmv30: item.last30dSales ?? null, gmv: item.totalSales ?? null, active: item.active, image: item.imageUrl || null,
    updatedAt: item.updatedAt || null, url: productUrl(item.id), score: Math.round(s * 100) / 100,
  };
}

// ---------- state ----------
let state = load(FILE, { runAt: null, finishedAt: null, skus: {}, errors: 0 });
let overrides = load(OVERRIDES, {}); // { sku: { ignore: [productId], pin: [productId] } }
let job = null;
let progress = { done: 0, total: 0, startedAt: null, lastError: null };
let me = { at: 0, ok: null, info: null, error: null };

function load(file, d) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return d; } }
function save(file, obj) {
  try { fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); fs.renameSync(file + ".tmp", file); }
  catch (e) { console.warn(`Couldn't save ${file}: ${e.message}`); }
}

async function searchSku(pr, ownIds) {
  const seen = new Map(), ov = overrides[pr.sku] || {};
  const ignore = new Set(ov.ignore || []), pin = new Set(ov.pin || []);
  let calls = 0;
  for (const q of queries(pr)) {
    const data = await euka(CFG.searchPath, { query: q, region: CFG.region, limit: 50, sortBy: "last30dSales" });
    calls++;
    for (const it of data.items || []) {
      const id = String(it.id);
      if (seen.has(id) || ownIds.has(id) || ignore.has(id) || it.active === false) continue;
      if (CFG.ourShops.length && CFG.ourShops.includes(String(it.brand?.name || "").toLowerCase())) continue;
      seen.set(id, slim(it, score(pr, it)));
    }
    const good = [...seen.values()].filter(x => x.score >= CFG.minScore).length;
    if (good >= CFG.perSku) break;
    if (CFG.delayMs) await sleep(CFG.delayMs);
  }
  for (const id of pin) {
    if (seen.has(id)) { seen.get(id).score = 1; seen.get(id).pinned = true; continue; }
    try { const it = await euka(`${CFG.searchPath}/${encodeURIComponent(id)}`, { region: CFG.region }); calls++; seen.set(id, { ...slim(it, 1), pinned: true }); }
    catch (e) { console.warn(`Pinned ${id} for ${pr.sku}: ${e.message}`); }
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score || (b.sold30 || 0) - (a.sold30 || 0));
  return {
    checkedAt: new Date().toISOString(), queries: queries(pr), calls,
    matches: ranked.filter(x => x.score >= CFG.minScore).slice(0, CFG.perSku),
    // A few near misses so a person can pin the right listing when matching gets it wrong.
    candidates: ranked.filter(x => x.score < CFG.minScore).slice(0, 5),
  };
}

function ownIdsFrom(list) {
  const ids = new Set();
  for (const p of list) {
    if (p.tiktok_product_id) ids.add(String(p.tiktok_product_id));
    try { const t = typeof p.igloo_tiktok === "string" ? JSON.parse(p.igloo_tiktok) : p.igloo_tiktok; if (t?.id) ids.add(String(t.id)); } catch {}
  }
  return ids;
}

async function run(list, onlySkus) {
  if (!CFG.key) throw new Error("EUKA_API_KEY is not set");
  if (job) return job;
  const ownIds = ownIdsFrom(list);
  const todo = list.filter(p => p.sku && p.name && (!onlySkus || onlySkus.includes(p.sku)));
  progress = { done: 0, total: todo.length, startedAt: new Date().toISOString(), lastError: null };
  const full = !onlySkus;
  if (full) state.runAt = progress.startedAt;
  let errors = 0, i = 0, authFailed = false;
  job = (async () => {
    const worker = async () => {
      while (i < todo.length && !authFailed) {
        const p = todo[i++];
        try { state.skus[p.sku] = await searchSku(profile(p), ownIds); }
        catch (e) {
          errors++; progress.lastError = `${p.sku}: ${e.message}`;
          if (e.status === 401 || e.status === 403) authFailed = true;
          state.skus[p.sku] = { ...(state.skus[p.sku] || {}), error: e.message, errorAt: new Date().toISOString() };
        }
        progress.done++;
        if (progress.done % 50 === 0) save(FILE, state);
        if (CFG.delayMs) await sleep(CFG.delayMs);
      }
    };
    await Promise.all(Array.from({ length: CFG.concurrency }, worker));
    if (full) { state.finishedAt = new Date().toISOString(); state.errors = errors; }
    save(FILE, state);
    console.log(`Competitor run done: ${progress.done}/${progress.total} SKUs, ${errors} errors${authFailed ? " (stopped: Euka rejected the API key)" : ""}`);
  })().finally(() => { job = null; });
  return job;
}

async function checkKey() {
  if (!CFG.key) return (me = { at: Date.now(), ok: false, info: null, error: "EUKA_API_KEY is not set" });
  if (Date.now() - me.at < 10 * 60 * 1000 && me.ok !== null) return me;
  try { me = { at: Date.now(), ok: true, info: await euka("/me"), error: null }; }
  catch (e) { me = { at: Date.now(), ok: false, info: null, error: e.message }; }
  return me;
}

// Kick off a full run when the saved one is older than the refresh window.
function schedule(getList) {
  const tick = async () => {
    if (!CFG.key || job) return;
    const age = state.runAt ? Date.now() - Date.parse(state.runAt) : Infinity;
    if (age < CFG.refreshHours * 3600 * 1000) return;
    try { const list = await getList(); console.log(`Starting competitor run for ${list.length} products`); run(list).catch(e => console.warn(`Competitor run failed: ${e.message}`)); }
    catch (e) { console.warn(`Competitor run skipped, products unavailable: ${e.message}`); }
  };
  setTimeout(tick, 15000).unref();
  setInterval(tick, 15 * 60 * 1000).unref();
}

// ---------- HTTP ----------
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((resolve, reject) => {
  let b = ""; req.on("data", c => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on("error", reject);
});
const authorized = (req, url) => !CFG.adminToken || req.headers["x-admin-token"] === CFG.adminToken || url.searchParams.get("token") === CFG.adminToken;

// Returns true when it handled the request.
async function handle(req, res, url, getList) {
  if (!url.pathname.startsWith("/api/competitors")) return false;
  const sub = url.pathname.slice("/api/competitors".length);
  try {
    if (sub === "" || sub === "/") {
      return send(res, 200, {
        configured: !!CFG.key, running: !!job, progress, runAt: state.runAt, finishedAt: state.finishedAt, errors: state.errors,
        refreshHours: CFG.refreshHours, perSku: CFG.perSku, minScore: CFG.minScore, region: CFG.region,
        nextRunAt: state.runAt ? new Date(Date.parse(state.runAt) + CFG.refreshHours * 3600 * 1000).toISOString() : null,
        needsToken: !!CFG.adminToken, skus: state.skus, overrides,
      }), true;
    }
    if (sub === "/status") {
      const k = await checkKey();
      return send(res, 200, { configured: !!CFG.key, keyOk: k.ok, key: k.info, error: k.error, running: !!job, progress }), true;
    }
    const pm = sub.match(/^\/product\/([^/]+)$/);
    if (pm) {
      if (!CFG.key) return send(res, 400, { error: "EUKA_API_KEY is not set on the server" }), true;
      return send(res, 200, await euka(`${CFG.searchPath}/${encodeURIComponent(decodeURIComponent(pm[1]))}`, { region: CFG.region })), true;
    }
    if (req.method !== "POST") return send(res, 405, { error: "POST only" }), true;
    if (!authorized(req, url)) return send(res, 401, { error: "Admin token required" }), true;
    if (!CFG.key) return send(res, 400, { error: "EUKA_API_KEY is not set on the server" }), true;
    if (sub === "/refresh") {
      const body = await readBody(req).catch(() => ({}));
      if (job) return send(res, 409, { error: "A refresh is already running", progress }), true;
      const list = await getList();
      const only = Array.isArray(body.skus) && body.skus.length ? body.skus.map(String) : null;
      const p = run(list, only);
      if (only && only.length <= 3) { await p; return send(res, 200, { ok: true, skus: Object.fromEntries(only.map(s => [s, state.skus[s]])) }), true; }
      return send(res, 202, { ok: true, started: true, total: progress.total }), true;
    }
    if (sub === "/override") {
      const { sku, productId, action } = await readBody(req);
      if (!sku || !productId || !["ignore", "pin", "clear"].includes(action)) return send(res, 400, { error: "sku, productId and action (ignore | pin | clear) are required" }), true;
      const o = overrides[sku] || (overrides[sku] = { ignore: [], pin: [] }), id = String(productId);
      o.ignore = o.ignore.filter(x => x !== id); o.pin = o.pin.filter(x => x !== id);
      if (action !== "clear") o[action].push(id);
      save(OVERRIDES, overrides);
      const list = await getList();
      if (!job) await run(list, [sku]);
      return send(res, 200, { ok: true, overrides: overrides[sku], result: state.skus[sku] }), true;
    }
    return send(res, 404, { error: "Unknown competitors endpoint" }), true;
  } catch (e) {
    console.error(`${url.pathname} failed: ${e.message}`);
    return send(res, 502, { error: e.message }), true;
  }
}

module.exports = { handle, schedule, CFG, _test: { profile, queries, score, sizes } };
