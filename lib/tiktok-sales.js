// Our own TikTok Shop sales for the last 7/14/30/60/90 days, from Euka's dashboard/products-performance
// (TikTok Product Analytics). The products API only carries 60- and 90-day totals, so this is the only
// source for shorter windows. Each window ends on Euka's latestAvailableDate (TikTok reports with a lag),
// and that date is returned so the page can say where the data stops.
const { euka, CFG } = require("./competitors");

const WINDOWS = [7, 14, 30, 60, 90];
const TTL_MS = +(process.env.TIKTOK_SALES_TTL_MIN || 60) * 60 * 1000;
let cache = { at: 0, data: null, error: null };
let inflight = null;

const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

let brandId = (process.env.EUKA_BRAND_ID || "").trim();
let brandInfo = null;   // what the key can see, returned when no brand has a TikTok Shop connected
const notConnected = e => /not connected to a TikTok Shop/i.test(e.message);
// The key may cover several brands; use the first one with a TikTok Shop connected in Euka.
async function pickBrand(range) {
  if (brandId) return brandId;
  const me = await euka("/me");
  const brands = await euka("/brands").catch(() => []);
  const stores = await euka("/stores").catch(() => []);
  const ids = [...new Set([...(me.brandIds || []), ...brands.map(b => b.id)])];
  brandInfo = { brands: brands.map(b => ({ id: b.id, name: b.name })), stores: stores.map(s => ({ name: s.name, region: s.region, shopId: s.shopId })) };
  for (const id of ids) {
    try { await euka("/dashboard/products-performance", {}, 1, { brandId: id, postedDateRange: range, pageSize: 1 }); return (brandId = id); }
    catch (e) { if (!notConnected(e)) throw e; }
  }
  const names = brandInfo.brands.map(b => b.name).join(", ") || "none";
  throw new Error(`None of this Euka key's brands (${names}) has a TikTok Shop connected in Euka`);
}

async function loadWindow(days, end) {
  const range = { start: addDays(end, -(days - 1)), end };
  const products = [];
  let token, latest = null, pages = 0, total = null;
  do {
    const r = await euka("/dashboard/products-performance", {}, 1, {
      brandId: await pickBrand(range), postedDateRange: range, pageSize: 100, sortField: "items_sold", sortOrder: "DESC", ...(token ? { pageToken: token } : {}),
    });
    products.push(...(r.products || []));
    latest = r.latestAvailableDate || latest; total = r.totalCount ?? total;
    token = r.nextPageToken; pages++;
  } while (token && pages < 100);
  return {
    days, start: range.start, end: range.end, latestAvailableDate: latest, totalCount: total, complete: !token,
    products: products.map(p => ({
      id: String(p.productId), units: p.itemsSold ?? 0, gmv: p.totalGmv ?? 0, orders: p.orders ?? 0,
      skus: (p.skus || []).map(s => s.sellerSku).filter(Boolean),
    })),
  };
}

async function load() {
  if (!CFG.key) throw new Error("EUKA_API_KEY is not set");
  // Ask for yesterday first to learn the latest finished reporting day, then end every window there.
  const yesterday = addDays(iso(new Date()), -1);
  const probe = await loadWindow(1, yesterday);
  const end = probe.latestAvailableDate && probe.latestAvailableDate < yesterday ? probe.latestAvailableDate : yesterday;
  const out = {};
  for (const d of WINDOWS) out[d] = await loadWindow(d, end);
  return { fetchedAt: new Date().toISOString(), end, latestAvailableDate: probe.latestAvailableDate, windows: out };
}

function get(force) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache);
  inflight ||= load()
    .then(data => { cache = { at: Date.now(), data, error: null }; })
    .catch(e => { console.warn(`TikTok sales load failed: ${e.message}`); cache = { ...cache, error: e.message }; })
    .finally(() => { inflight = null; });
  // Serve the last good copy while a refresh runs; wait only when there's nothing yet.
  return cache.data ? Promise.resolve(cache) : inflight.then(() => cache);
}

async function handle(req, res, url) {
  if (url.pathname !== "/api/tiktok-sales") return false;
  const c = await get(url.searchParams.has("refresh"));
  res.writeHead(c.data ? 200 : 502, { "content-type": "application/json" });
  res.end(JSON.stringify({ configured: !!CFG.key, error: c.error, ...(c.error ? { access: brandInfo } : {}), ...(c.data || {}) }));
  return true;
}

module.exports = { handle, get };
