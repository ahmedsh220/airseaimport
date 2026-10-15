// TikTok Shop competitor prices from Euka's OpenAPI (https://server.euka.ai/docs).
// For every SKU in the products API we search two Euka indexes by name:
//   - Social Intelligence products: current listed price, strike-through price, shipping, lifetime units.
//   - Market Intelligence product/rank: also finds listings with no sales this month (need_all), plus
//     seller name, affiliate commission and GMV growth. product/detail then adds the min/max SKU price,
//     creator/video counts and review count for each kept match.
// Results are merged by TikTok product id, scored against our product (name words + size), the best N
// kept and saved to disk. The dashboard reads it from /api/competitors.
// Nothing runs on its own: each click on "Search next 100" searches the next batch of SKUs (in SKU order), picking
// up after the SKU the last batch stopped at and starting over from the top once the end is reached.
const fs = require("fs");
const path = require("path");
const activity = require("./activity");
const { readJson, sendJson: send } = require("./http");

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
  // SKUs searched per click on "Search next 100".
  batchSize: Math.max(1, +env("COMPETITOR_BATCH_SIZE", "100")),
  concurrency: Math.max(1, +env("EUKA_CONCURRENCY", "2")),
  // Euka rate-limits the key, so every call is spaced at least this far apart across all workers.
  minIntervalMs: +env("EUKA_MIN_INTERVAL_MS", "1500"),
  delayMs: +env("EUKA_DELAY_MS", "250"),
  minScore: +env("COMPETITOR_MIN_SCORE", "0.6"),
  ourShops: env("OUR_TIKTOK_SHOP_NAMES", "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  dataDir: env("COMPETITOR_DATA_DIR", path.join(__dirname, "..", "data")),
};
const FILE = path.join(CFG.dataDir, "competitors.json");
const OVERRIDES = path.join(CFG.dataDir, "competitor-overrides.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Euka client ----------
// GET with query params, or POST with a JSON body when `body` is given.
let lastCall = null; // last Euka response, shown on /api/competitors/status
// Euka's weekly quota: once it's used up nothing is called until it resets (Monday 00:00 UTC).
let quotaUntil = 0;
function nextMondayUtc() {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  return +d;
}

// Shared pacing: one call per minIntervalMs, and after a 429 every worker waits until pauseUntil.
let nextSlot = 0, pauseUntil = 0, backoffMs = 0;
async function pace() {
  for (;;) {
    const now = Date.now(), at = Math.max(nextSlot, pauseUntil);
    if (at <= now) { nextSlot = now + CFG.minIntervalMs; return; }
    await sleep(at - now);
  }
}
function rateLimited(res) {
  const ra = +res.headers.get("retry-after");
  backoffMs = Math.min(Math.max(backoffMs * 2, 15000), 10 * 60 * 1000);
  const wait = ra > 0 && ra < 15 * 60 ? ra * 1000 : backoffMs;
  pauseUntil = Math.max(pauseUntil, Date.now() + wait);
  return wait;
}

// opts.fast429: give up on a rate limit at once (with err.retryAfter) instead of waiting it out.
async function euka(p, params = {}, attempt = 1, body = null, opts = {}) {
  if (Date.now() < quotaUntil) { const e = new Error(`Euka weekly quota used up; resets ${new Date(quotaUntil).toISOString()}`); e.status = 429; e.quota = true; throw e; }
  await pace();
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
    console.warn(`Euka ${p} attempt ${attempt} failed: ${e.message}`);
    lastCall = { at: new Date().toISOString(), path: p, error: e.message };
    if (attempt < 4) { await sleep(attempt * 2000); return euka(p, params, attempt + 1, body, opts); }
    throw new Error(`Euka unreachable: ${e.message}`);
  }
  lastCall = { at: new Date().toISOString(), path: p, status: res.status };
  if (res.status === 429) {
    const text = await res.clone().text().catch(() => "");
    if (/quota exceeded/i.test(text)) {
      quotaUntil = Math.max(quotaUntil, nextMondayUtc());
      state.quotaUntil = new Date(quotaUntil).toISOString();
      const err = new Error(`Euka weekly quota used up; resets ${state.quotaUntil}`);
      err.status = 429; err.quota = true; err.retryAfter = Math.ceil((quotaUntil - Date.now()) / 1000);
      throw err;
    }
  }
  if (res.status === 429 && opts.fast429) {
    const err = new Error(`Euka rate limit on ${p}`);
    err.status = 429; err.retryAfter = +res.headers.get("retry-after") || null;
    throw err;
  }
  if (res.status === 429 && attempt < 8) {
    const wait = rateLimited(res);
    console.warn(`Euka ${p} rate limited; all calls paused ${Math.round(wait / 1000)}s (attempt ${attempt})`);
    return euka(p, params, attempt + 1, body, opts);
  }
  if (res.status >= 500 && attempt < 5) {
    console.warn(`Euka ${p} HTTP ${res.status}, retrying in ${attempt * 3}s (attempt ${attempt})`);
    await sleep(attempt * 3000);
    return euka(p, params, attempt + 1, body, opts);
  }
  if (res.ok) backoffMs = 0;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Euka HTTP ${res.status}: ${text.slice(0, 600).replace(/\s+/g, " ")}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// Social Intelligence reads are made "for" one of the key's Euka brands (required).
let brandCache = (process.env.EUKA_BRAND_ID || "").trim() || null;
async function brandId() {
  if (!brandCache) brandCache = (await euka("/me")).brandIds?.[0] || (await euka("/brands"))?.[0]?.id || null;
  if (!brandCache) throw new Error("This Euka key has no brand");
  return brandCache;
}

// Market Intelligence wraps results as { success, data, message, code }.
const MI_BASE = { region: "US", language: "en-US", currency: "USD", date_range: "last30Day" };
async function mi(p, body) {
  const r = await euka(`/market-intelligence/tiktok/${p}`, {}, 1, { ...MI_BASE, region: CFG.region === "UK" ? "GB" : CFG.region, ...body }, { fast429: true });
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
  return { sku: p.sku, name: p.name, words: [...new Set(words(name))], sizes: sizes(p.name), tiktokId: ownId(p) };
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
// cursor: the last SKU the last batch got through. skus: the latest result for each SKU.
let state = load(FILE, { runAt: null, finishedAt: null, cursor: null, skus: {}, errors: 0 });
if (state.quotaUntil && Date.parse(state.quotaUntil) > Date.now()) quotaUntil = Date.parse(state.quotaUntil);
let overrides = load(OVERRIDES, {}); // { sku: { ignore: [productId], pin: [productId] } }
let job = null;
let progress = { done: 0, total: 0, startedAt: null, lastError: null };
let me = { at: 0, ok: null, info: null, error: null };
// Whether Market Intelligence answered during the current/last run. Reset at the start of each run.
let miState = { ok: null, error: null, at: null };
const useMi = () => {
  if (!CFG.sources.includes("market")) return false;
  if (miState.until && Date.now() >= miState.until) miState = { ok: null, error: null, at: null };
  return miState.ok !== false;
};
const useSocial = () => CFG.sources.includes("social");
function miFailed(e) {
  // Rate limited: carry on with product search alone and try market intelligence again later,
  // rather than stalling every SKU on minute-long retries.
  if (e.status === 429) {
    const until = Date.now() + Math.max((e.retryAfter || 0) * 1000, 30 * 60 * 1000);
    if (miState.ok !== false) console.warn(`Market intelligence rate limited; product search only until ${new Date(until).toISOString()}`);
    miState = { ok: false, error: `Euka rate limit, paused until ${new Date(until).toISOString()}`, at: new Date().toISOString(), until };
    return true;
  }
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
  let calls = 0, own = null;
  if (pr.tiktokId && useMi()) {
    try { const had = state.own?.[pr.tiktokId]; own = await ownListing(pr.tiktokId); if (own !== had) calls++; }
    catch (e) { if (!miFailed(e)) console.warn(`Own listing ${pr.tiktokId} for ${pr.sku}: ${e.message}`); }
  }
  // Our listing's TikTok category, unless categories are fixed in the environment.
  const cats = CFG.miCategoryIds.length ? CFG.miCategoryIds : own?.cat ? [own.cat] : [];
  const add = x => {
    if (own?.shopId && x.shopId && String(x.shopId) === String(own.shopId)) return;
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
        // brandId is required; Euka rejects any `limit`, so each call returns its default 20.
        const data = await euka(CFG.searchPath, { brandId: await brandId(), query: q, region: CFG.region, sortBy: "last30dSales" });
        calls++;
        for (const it of data.items || []) add(slim(it, 0));
      } catch (e) { if (!useMi() || e.status === 401 || e.status === 403) throw e; socialErr = e; }
    }
    if (useMi()) {
      try {
        const rows = await mi("product/rank", {
          keyword: q, need_all: true, need_extra: true, need_image: 1, page_size: 50, page_number: 1,
          sort_field: { field: "revenue", type: "DESC" }, ...(cats.length ? { category_ids: cats } : {}),
        });
        calls++;
        if (miState.ok !== true) miState = { ok: true, error: null, at: new Date().toISOString() };
        for (const row of rows || []) if (row?.product_id) add(slimMi(row));
      } catch (e) { if (!miFailed(e) && !useSocial()) throw e; }
    }
    if (socialErr && !useMi()) throw socialErr;
    const good = [...seen.values()].filter(x => x.score >= CFG.minScore).length;
    // Shorter fallback searches only run when nothing matched yet, to save rate-limited calls.
    if (good >= 1) break;
    if (CFG.delayMs) await sleep(CFG.delayMs);
  }
  for (const id of pin) {
    if (seen.has(id)) { seen.get(id).score = 1; seen.get(id).pinned = true; continue; }
    let got = null;
    if (useSocial()) {
      try { got = slim(await euka(`${CFG.searchPath}/${encodeURIComponent(id)}`, { brandId: await brandId(), region: CFG.region }), 1); calls++; }
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
    own: own ? { id: own.id, title: own.title, cat: own.cat, minPrice: own.minPrice, maxPrice: own.maxPrice, sold30: own.sold30, url: own.url } : null,
    // A listing found only by Market Intelligence with several SKU prices has no listed price we can
    // trust, so it is kept for context but left out of the lowest/median/highest maths on the page.
    matches,
    // A few near misses so a person can pin the right listing when matching gets it wrong.
    candidates: ranked.filter(x => x.score < CFG.minScore).slice(0, 5),
  };
}

function ownIdsOf(p) {
  const ids = [];
  if (p.tiktok_product_id) ids.push(String(p.tiktok_product_id));
  try { const t = typeof p.igloo_tiktok === "string" ? JSON.parse(p.igloo_tiktok) : p.igloo_tiktok; if (t?.id) ids.push(String(t.id)); } catch {}
  return ids;
}
function ownIdsFrom(list) { return new Set(list.flatMap(ownIdsOf)); }
// Our own TikTok listing for a SKU, from the products API.
function ownId(p) { return ownIdsOf(p)[0] || null; }

// Our own listing, looked up by its TikTok product ID. Its category tells us exactly which TikTok
// subcategory the competitors sit in, so the Market Intelligence search can be limited to it.
// Kept for a week since a listing's category rarely changes.
async function ownListing(id) {
  const c = state.own?.[id];
  if (c && ageMs(c.at) < 7 * 24 * 3600 * 1000) return c;
  const d = await mi("product/detail", { product_id: id });
  if (!d) return c || null;
  const o = {
    at: new Date().toISOString(), id, title: d.product_name || null, shopId: d.product_shop_id || null,
    cat: d.ter_cate_id || d.sec_cate_id || d.pri_cate_id || null, cats: [d.pri_cate_id, d.sec_cate_id, d.ter_cate_id].filter(Boolean),
    minPrice: num(d.min_price), maxPrice: num(d.max_price), sold30: num(d.sales_volumn), gmv30: num(d.revenue), url: productUrl(id),
  };
  (state.own || (state.own = {}))[id] = o;
  return o;
}

const ageMs = t => t ? Date.now() - Date.parse(t) : Infinity;
const searchable = list => list.filter(p => p.sku && p.name).sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
// Where the next batch starts: the first SKU after the cursor, or the top of the list once past the end.
function batchStart(all) {
  const i = state.cursor == null ? 0 : all.findIndex(p => p.sku > state.cursor);
  return i < 0 ? 0 : i;
}
// Results only for SKUs still in the products API, and our own listings only while a SKU points at them,
// so competitors.json never holds more than one entry per current product.
function forgetGone(list, ownIds) {
  const skus = new Set(list.map(p => p.sku));
  for (const k of Object.keys(state.skus)) if (!skus.has(k)) delete state.skus[k];
  for (const id of Object.keys(state.own || {})) if (!ownIds.has(id)) delete state.own[id];
}

// Searches the named SKUs (a re-check or pin from the page), or else the next batch.
async function run(list, onlySkus) {
  if (!CFG.key) throw new Error("EUKA_API_KEY is not set");
  if (job) return job;
  const ownIds = ownIdsFrom(list), all = searchable(list), batch = !onlySkus;
  const from = batchStart(all);
  const todo = batch ? all.slice(from, from + CFG.batchSize) : all.filter(p => onlySkus.includes(p.sku));
  progress = { done: 0, total: todo.length, from: from + 1, of: all.length, startedAt: new Date().toISOString(), lastError: null };
  if (!miState.until) miState = { ok: null, error: null, at: null };
  if (!todo.length) return;
  if (batch) { forgetGone(all, ownIds); state.runAt = progress.startedAt; state.finishedAt = null; }
  // finished[k]: todo[k] has its result. The cursor moves past the SKUs finished in an unbroken run from the
  // start of the batch, so a batch cut short (quota, restart) is picked up again at the first one it missed.
  const finished = [];
  let errors = 0, i = 0, authFailed = false;
  const moveCursor = () => {
    if (!batch) return;
    let k = 0; while (finished[k]) k++;
    if (k) state.cursor = todo[k - 1].sku;
  };
  job = (async () => {
    const worker = async () => {
      while (i < todo.length && !authFailed && Date.now() >= quotaUntil) {
        const at = i++, p = todo[at];
        try { state.skus[p.sku] = await searchSku(profile(p), ownIds); finished[at] = true; }
        catch (e) {
          // Out of weekly quota: keep this SKU's last result and stop; the next batch starts again from here.
          if (e.quota) { progress.lastError = e.message; break; }
          errors++; progress.lastError = `${p.sku}: ${e.message}`;
          state.skus[p.sku] = { ...(state.skus[p.sku] || {}), error: e.message, errorAt: new Date().toISOString() };
          // A rejected key stops the batch without moving past this SKU; any other failure is this SKU's result.
          if (e.status === 401 || e.status === 403) authFailed = true; else finished[at] = true;
        }
        progress.done++;
        if (progress.done % 10 === 0) { moveCursor(); save(FILE, state); }
        if (progress.done % 50 === 0) {
          const v = Object.values(state.skus);
          console.log(`Competitor progress ${progress.done}/${progress.total}: ${v.filter(x => x.matches?.length).length} SKUs with matches, ${v.filter(x => x.error).length} with errors${progress.lastError ? `; last error ${progress.lastError.slice(0, 200)}` : ""}`);
        }
        if (CFG.delayMs) await sleep(CFG.delayMs);
      }
    };
    await Promise.all(Array.from({ length: CFG.concurrency }, worker));
    moveCursor();
    if (batch) { state.finishedAt = new Date().toISOString(); state.errors = errors; }
    state.marketIntel = miState;
    save(FILE, state);
    console.log(`Competitor ${batch ? "batch" : "re-check"} done: ${progress.done}/${progress.total} SKUs, ${errors} errors${authFailed ? " (stopped: Euka rejected the API key)" : ""}${Date.now() < quotaUntil ? ` (stopped: Euka weekly quota used up until ${new Date(quotaUntil).toISOString()})` : ""}`);
  })().finally(() => { job = null; });
  return job;
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

// ---------- HTTP ----------
// Where the next batch starts, for the page: "SKUs 101–200 of 1,234, from PER 0456".
async function nextBatchInfo(getList) {
  try {
    const all = searchable(await getList()), from = batchStart(all), to = Math.min(from + CFG.batchSize, all.length);
    return { size: CFG.batchSize, from: from + 1, to, of: all.length, firstSku: all[from]?.sku || null };
  } catch { return { size: CFG.batchSize, from: null, to: null, of: null, firstSku: null }; }
}
// Ignored and pinned listings kept per SKU.
const MAX_OVERRIDES = 50;

// Returns true when it handled the request.
async function handle(req, res, url, getList) {
  if (!url.pathname.startsWith("/api/competitors")) return false;
  const sub = url.pathname.slice("/api/competitors".length);
  try {
    if (sub === "" || sub === "/") {
      return send(res, 200, {
        configured: !!CFG.key, running: !!job, progress, runAt: state.runAt, finishedAt: state.finishedAt, errors: state.errors,
        perSku: CFG.perSku, minScore: CFG.minScore, region: CFG.region, next: await nextBatchInfo(getList),
        quotaUntil: Date.now() < quotaUntil ? new Date(quotaUntil).toISOString() : null, saved: savedTo(),
        sources: CFG.sources, marketIntel: job ? miState : state.marketIntel || miState,
        skus: state.skus, overrides,
      }), true;
    }
    if (sub === "/status") {
      const k = await checkKey();
      return send(res, 200, { configured: !!CFG.key, keyOk: k.ok, key: k.info, error: k.error, running: !!job, progress, lastCall }), true;
    }
    if (req.method !== "POST") return send(res, 405, { error: "POST only" }), true;
    if (!CFG.key) return send(res, 400, { error: "EUKA_API_KEY is not set on the server" }), true;
    if (sub === "/refresh") {
      const body = await readJson(req);
      if (job) return send(res, 409, { error: "A search is already running", progress }), true;
      if (Date.now() < quotaUntil) return send(res, 200, { ok: true, started: false, message: `Euka's weekly limit is used up. Searching resumes ${new Date(quotaUntil).toUTCString()}.` }), true;
      const list = await getList();
      // At most one batch of named SKUs; anything more is what "Search next 100" is for.
      const only = Array.isArray(body.skus) && body.skus.length ? body.skus.slice(0, CFG.batchSize).map(String) : null;
      const p = run(list, only);
      if (!only && !progress.total) return send(res, 200, { ok: true, started: false, message: "There are no products to search." }), true;
      activity.log("COMPETITOR SEARCH", only ? `re-check ${only.slice(0, 20).join(", ")}${only.length > 20 ? ` and ${only.length - 20} more` : ""}`
        : `next batch: SKUs ${progress.from}–${progress.from + progress.total - 1} of ${progress.of}`, req);
      if (only && only.length <= 3) { await p; return send(res, 200, { ok: true, skus: Object.fromEntries(only.map(s => [s, state.skus[s]])) }), true; }
      return send(res, 202, { ok: true, started: true, total: progress.total }), true;
    }
    if (sub === "/override") {
      const { sku, productId, action } = await readJson(req);
      if (typeof sku !== "string" || !sku.trim() || ["__proto__", "constructor", "prototype"].includes(sku) || !productId || !["ignore", "pin", "clear"].includes(action)) return send(res, 400, { error: "sku, productId and action (ignore | pin | clear) are required" }), true;
      // A pasted TikTok link works as well as a bare product ID.
      const id = (String(productId).match(/\d{15,22}/) || [String(productId).trim()])[0];
      if (!/^\d{1,22}$/.test(id)) return send(res, 400, { error: "That isn't a TikTok product ID or listing link" }), true;
      const list = await getList();
      if (!list.some(p => p.sku === sku)) return send(res, 400, { error: `SKU ${sku} isn't in the products API` }), true;
      const o = overrides[sku] || { ignore: [], pin: [] };
      o.ignore = o.ignore.filter(x => x !== id); o.pin = o.pin.filter(x => x !== id);
      if (action !== "clear") {
        if (o[action].length >= MAX_OVERRIDES) return send(res, 400, { error: `A SKU can have up to ${MAX_OVERRIDES} ${action === "pin" ? "pinned" : "hidden"} listings` }), true;
        o[action].push(id);
      }
      if (o.ignore.length || o.pin.length) overrides[sku] = o; else delete overrides[sku];
      save(OVERRIDES, overrides);
      activity.log("COMPETITOR OVERRIDE", `${sku}: ${{ ignore: "marked not a match", pin: "pinned", clear: "cleared" }[action]} TikTok listing ${id}`, req);
      if (!job) await run(list, [sku]);
      return send(res, 200, { ok: true, overrides: overrides[sku], result: state.skus[sku] }), true;
    }
    return send(res, 404, { error: "Unknown competitors endpoint" }), true;
  } catch (e) {
    console.error(`${url.pathname} failed: ${e.message}`);
    return send(res, [400, 413].includes(e.status) ? e.status : 502, { error: e.message }), true;
  }
}

module.exports = { handle };
