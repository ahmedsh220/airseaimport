// TikTok Shop competitor prices from Euka's OpenAPI (https://server.euka.ai/docs).
// For every SKU in the products API we search two Euka indexes by name:
//   - Social Intelligence products: current listed price, strike-through price, shipping, lifetime units.
//   - Market Intelligence product/rank: also finds listings with no sales this month (need_all), plus
//     seller name, affiliate commission and GMV growth. product/detail then adds the min/max SKU price,
//     creator/video counts and review count for each kept match.
// Results are merged by TikTok product id, scored against our product (name words + size), the best N
// kept and saved to disk. The dashboard reads it from /api/competitors.
const fs = require("fs");
const path = require("path");

const env = (k, d) => (process.env[k] ?? "").trim() || d;
const CFG = {
  key: env("EUKA_API_KEY", ""),
  base: env("EUKA_API_BASE", "https://server.euka.ai/api/v1").replace(/\/+$/, ""),
  searchPath: env("EUKA_PRODUCT_SEARCH_PATH", "/social-intelligence/products"),
  // "social", "market" or both (comma separated). Market Intelligence is skipped for the rest of a run
  // if Euka refuses it (for example when the key's plan doesn't include it).
  sources: env("EUKA_SOURCES", "social,market").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  miDetail: env("EUKA_MI_DETAIL", "1") !== "0",
  miCategoryIds: env("EUKA_MI_CATEGORY_IDS", "").split(",").map(s => s.trim()).filter(Boolean),
  region: env("EUKA_REGION", "US"),
  perSku: +env("COMPETITORS_PER_SKU", "5"),
  refreshHours: +env("COMPETITOR_REFRESH_HOURS", "12"),
  // A SKU is never searched again within this many hours, even from "Refresh all now".
  minGapHours: +env("COMPETITOR_MIN_GAP_HOURS", "2"),
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
// GET with query params, or POST with a JSON body when `body` is given.
async function euka(p, params = {}, attempt = 1, body = null) {
  const u = new URL(CFG.base + p);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, x)); else u.searchParams.set(k, v);
  }
  let res;
  try {
    const headers = { authorization: `Bearer ${CFG.key}`, accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    res = await fetch(u, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    if (attempt < 4) { await sleep(attempt * 2000); return euka(p, params, attempt + 1, body); }
    throw new Error(`Euka unreachable: ${e.message}`);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) {
      const wait = (+res.headers.get("retry-after") || attempt * 3) * 1000;
      await sleep(Math.min(wait, 60000));
      return euka(p, params, attempt + 1, body);
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

// Market Intelligence wraps results as { success, data, message, code }.
const MI_BASE = { region: "US", language: "en-US", currency: "USD", date_range: "last30Day" };
async function mi(p, body) {
  const r = await euka(`/market-intelligence/tiktok/${p}`, {}, 1, { ...MI_BASE, region: CFG.region === "UK" ? "GB" : CFG.region, ...body });
  if (r && r.success === false) {
    const err = new Error(`Euka market intelligence: ${r.message || r.code || "request failed"}`);
    err.status = 400; throw err;
  }
  return r?.data;
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

// /view/product/ links hit a TikTok security check (502 in browsers); /shop/pdp/ opens the listing.
const productUrl = id => `https://www.tiktok.com/shop/pdp/${encodeURIComponent(id)}`;
const num = v => v == null || v === "" || isNaN(+v) ? null : +v;
function slim(item, s) {
  return {
    sources: ["social"],
    id: String(item.id), title: item.title, shop: item.brand?.name || null, shopId: item.brandId || item.brand?.id || null,
    price: item.price?.current ?? null, original: item.price?.original ?? null, shipping: item.price?.shipping ?? null,
    currency: item.currencyCode || "USD", sold: item.soldCount ?? null, sold30: item.last30dSoldCount ?? null,
    gmv30: item.last30dSales ?? null, gmv: item.totalSales ?? null, active: item.active, image: item.imageUrl || null,
    updatedAt: item.updatedAt || null, url: productUrl(item.id), score: Math.round(s * 100) / 100,
  };
}

// A Market Intelligence rank row in the same shape. Its unit_price is the average selling price over
// the period, not the listed price, so it is only used as the price when the listing has no other.
function slimMi(row) {
  const avg = num(row.unit_price) || null;  // 0 when the listing sold nothing this period
  return {
    sources: ["market"], id: String(row.product_id), title: row.product_name || null, shop: row.seller_name || null,
    shopId: row.seller_id || null, price: avg, priceIsAvg: avg != null, original: null, shipping: null, currency: "USD",
    sold: null, sold30: num(row.sales_volumn), gmv30: num(row.revenue), gmv: null, active: null,
    image: row.master_image_url || null, updatedAt: null, url: productUrl(row.product_id),
    avgPrice: avg, commission: num(row.commission_rate), growth: num(row.revenue_growth_rate),
    launchedAt: row.launch_date || null, skuCount: num(row.sku_count),
    videoGmv30: num(row.video_revenue), liveGmv30: num(row.live_revenue), shopGmv30: num(row.showcase_revenue),
  };
}

// Combine what both indexes know about one listing: Social Intelligence wins on price, MI fills gaps.
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (out[k] == null && v != null) out[k] = v;
  out.sources = [...new Set([...(a.sources || []), ...(b.sources || [])])];
  if (a.price != null && !a.priceIsAvg) out.priceIsAvg = false;
  if (a.price == null && b.price != null) { out.price = b.price; out.priceIsAvg = b.priceIsAvg; }
  return out;
}

// product/detail: min/max SKU price, creators, videos, reviews. When every SKU of the listing has one
// price, that is its listed price, which beats an average.
async function enrich(m) {
  const d = await mi("product/detail", { product_id: m.id, need_image: 1, need_extra: true });
  if (!d) return m;
  const min = num(d.min_price), max = num(d.max_price);
  Object.assign(m, {
    minPrice: min, maxPrice: max, creators: num(d.creator_number), videos: num(d.video_number), lives: num(d.live_number),
    reviews: num(d.product_review_count), delivery: d.delivery_type || null,
    commission: m.commission ?? num(d.commission_rate), avgPrice: m.avgPrice ?? num(d.unit_price),
    sold30: m.sold30 ?? num(d.sales_volumn), gmv30: m.gmv30 ?? num(d.revenue), image: m.image || d.master_image_url || null,
    title: m.title || d.product_name || null, detailAt: new Date().toISOString(),
  });
  if (m.priceIsAvg && min != null && min === max) { m.price = min; m.priceIsAvg = false; }
  return m;
}

// ---------- state ----------
let state = load(FILE, { runAt: null, finishedAt: null, skus: {}, errors: 0 });
let overrides = load(OVERRIDES, {}); // { sku: { ignore: [productId], pin: [productId] } }
let job = null;
let progress = { done: 0, total: 0, startedAt: null, lastError: null };
let me = { at: 0, ok: null, info: null, error: null };
// Whether Market Intelligence answered during the current/last run. Reset at the start of each run.
let miState = { ok: null, error: null, at: null };
const useMi = () => CFG.sources.includes("market") && miState.ok !== false;
const useSocial = () => CFG.sources.includes("social");
function miFailed(e) {
  // 401 means the key itself is bad, which the social search reports too. Anything else in the 4xx
  // range means MI isn't available to this key, so stop asking for this run.
  if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
    if (miState.ok !== false) console.warn(`Market intelligence off for this run: ${e.message}`);
    miState = { ok: false, error: e.message, at: new Date().toISOString() };
    return true;
  }
  return false;
}

function load(file, d) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return d; } }
function save(file, obj) {
  try { fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); fs.renameSync(file + ".tmp", file); }
  catch (e) { console.warn(`Couldn't save ${file}: ${e.message}`); }
}

async function searchSku(pr, ownIds) {
  const seen = new Map(), ov = overrides[pr.sku] || {};
  const ignore = new Set(ov.ignore || []), pin = new Set(ov.pin || []);
  let calls = 0;
  const add = x => {
    if (ownIds.has(x.id) || ignore.has(x.id) || x.active === false) return;
    if (CFG.ourShops.length && CFG.ourShops.includes(String(x.shop || "").toLowerCase())) return;
    const m = seen.has(x.id) ? merge(seen.get(x.id), x) : x;
    m.score = Math.round(score(pr, m) * 100) / 100;
    seen.set(x.id, m);
  };
  for (const q of queries(pr)) {
    let socialErr = null;
    if (useSocial()) {
      try {
        const data = await euka(CFG.searchPath, { query: q, region: CFG.region, limit: 50, sortBy: "last30dSales" });
        calls++;
        for (const it of data.items || []) add(slim(it, 0));
      } catch (e) { if (!useMi() || e.status === 401 || e.status === 403) throw e; socialErr = e; }
    }
    if (useMi()) {
      try {
        const rows = await mi("product/rank", {
          keyword: q, need_all: true, need_extra: true, need_image: 1, page_size: 50, page_number: 1,
          sort_field: { field: "revenue", type: "DESC" }, ...(CFG.miCategoryIds.length ? { category_ids: CFG.miCategoryIds } : {}),
        });
        calls++;
        if (miState.ok !== true) miState = { ok: true, error: null, at: new Date().toISOString() };
        for (const row of rows || []) if (row?.product_id) add(slimMi(row));
      } catch (e) { if (!miFailed(e) && !useSocial()) throw e; }
    }
    if (socialErr && !useMi()) throw socialErr;
    const good = [...seen.values()].filter(x => x.score >= CFG.minScore).length;
    if (good >= CFG.perSku) break;
    if (CFG.delayMs) await sleep(CFG.delayMs);
  }
  for (const id of pin) {
    if (seen.has(id)) { seen.get(id).score = 1; seen.get(id).pinned = true; continue; }
    let got = null;
    if (useSocial()) {
      try { got = slim(await euka(`${CFG.searchPath}/${encodeURIComponent(id)}`, { region: CFG.region }), 1); calls++; }
      catch (e) { console.warn(`Pinned ${id} for ${pr.sku}: ${e.message}`); }
    }
    if (!got && useMi()) {
      try { got = await enrich(slimMi({ product_id: id })); calls++; }
      catch (e) { miFailed(e); console.warn(`Pinned ${id} for ${pr.sku}: ${e.message}`); }
    }
    if (got) seen.set(id, { ...got, score: 1, pinned: true });
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score || (b.sold30 || 0) - (a.sold30 || 0));
  const matches = ranked.filter(x => x.score >= CFG.minScore).slice(0, CFG.perSku);
  if (CFG.miDetail) {
    for (const m of matches) {
      if (!useMi() || m.detailAt) continue;
      try { await enrich(m); calls++; } catch (e) { if (!miFailed(e)) console.warn(`MI detail ${m.id}: ${e.message}`); }
      if (CFG.delayMs) await sleep(CFG.delayMs);
    }
  }
  return {
    checkedAt: new Date().toISOString(), queries: queries(pr), calls,
    // A listing found only by Market Intelligence with several SKU prices has no listed price we can
    // trust, so it is kept for context but left out of the lowest/median/highest maths on the page.
    matches,
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

// Each SKU keeps its last result until it is searched again, and is only searched again once that
// result is older than the refresh window (or minGapHours for a manual "refresh all"). So a run that
// is interrupted by a restart picks up where it stopped instead of starting over.
const ageMs = t => t ? Date.now() - Date.parse(t) : Infinity;
const lastTry = x => Math.min(ageMs(x?.checkedAt), ageMs(x?.errorAt));
const isDue = (sku, hours) => lastTry(state.skus[sku]) >= hours * 3600 * 1000;
const dueList = (list, hours) => list.filter(p => p.sku && p.name && isDue(p.sku, hours));

async function run(list, onlySkus, minAgeHours = CFG.refreshHours) {
  if (!CFG.key) throw new Error("EUKA_API_KEY is not set");
  if (job) return job;
  const ownIds = ownIdsFrom(list);
  // Named SKUs (a re-check or pin from the page) are searched now; a pass only takes SKUs that are due.
  const todo = onlySkus ? list.filter(p => p.sku && p.name && onlySkus.includes(p.sku)) : dueList(list, minAgeHours);
  progress = { done: 0, total: todo.length, startedAt: new Date().toISOString(), lastError: null };
  miState = { ok: null, error: null, at: null };
  const full = !onlySkus;
  if (full && !todo.length) { job = null; return Promise.resolve(); }
  if (full) { state.runAt = progress.startedAt; state.finishedAt = null; }
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
        if (progress.done % 10 === 0) save(FILE, state);
        if (CFG.delayMs) await sleep(CFG.delayMs);
      }
    };
    await Promise.all(Array.from({ length: CFG.concurrency }, worker));
    if (full) { state.finishedAt = new Date().toISOString(); state.errors = errors; }
    state.marketIntel = miState;
    save(FILE, state);
    console.log(`Competitor run done: ${progress.done}/${progress.total} SKUs, ${errors} errors${authFailed ? " (stopped: Euka rejected the API key)" : ""}`);
  })().finally(() => { job = null; });
  return job;
}

// When the oldest SKU result falls due again.
function nextDue() {
  let oldest = Infinity;
  for (const x of Object.values(state.skus)) { const t = Date.parse(x.checkedAt || x.errorAt || 0); if (t < oldest) oldest = t; }
  return Number.isFinite(oldest) ? new Date(oldest + CFG.refreshHours * 3600 * 1000).toISOString() : null;
}
// Whether results survive a restart: only when COMPETITOR_DATA_DIR points at a persistent disk.
const savedTo = () => ({ dir: CFG.dataDir, persistent: !!process.env.COMPETITOR_DATA_DIR });

async function checkKey() {
  if (!CFG.key) return (me = { at: Date.now(), ok: false, info: null, error: "EUKA_API_KEY is not set" });
  if (Date.now() - me.at < 10 * 60 * 1000 && me.ok !== null) return me;
  try { me = { at: Date.now(), ok: true, info: await euka("/me"), error: null }; }
  catch (e) { me = { at: Date.now(), ok: false, info: null, error: e.message }; }
  return me;
}

// Every 15 minutes, search the SKUs whose last result is older than the refresh window. After a
// restart this resumes the unfinished SKUs; SKUs searched recently are left alone.
function schedule(getList) {
  const tick = async () => {
    if (!CFG.key || job) return;
    try {
      const list = await getList(), due = dueList(list, CFG.refreshHours);
      if (!due.length) return;
      console.log(`Competitor run: ${due.length} of ${list.length} SKUs due (older than ${CFG.refreshHours}h)`);
      run(list).catch(e => console.warn(`Competitor run failed: ${e.message}`));
    }
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
        nextRunAt: nextDue(), minGapHours: CFG.minGapHours, saved: savedTo(),
        needsToken: !!CFG.adminToken, sources: CFG.sources, marketIntel: job ? miState : state.marketIntel || miState,
        skus: state.skus, overrides,
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
      if (!only && !dueList(list, CFG.minGapHours).length) return send(res, 200, { ok: true, started: false, message: `Every SKU was searched in the last ${CFG.minGapHours} hours` }), true;
      const p = run(list, only, CFG.minGapHours);
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

module.exports = { handle, schedule, CFG, euka, _test: { profile, queries, score, sizes, slimMi, merge } };
