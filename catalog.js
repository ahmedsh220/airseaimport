// Customer wholesale catalog at /catalog, behind its own password (CATALOG_PASSWORD), separate from
// the admin dashboard. Built from the live products API on every load, so prices follow the API.
// Only what the printed catalog shows leaves the server: SKU, UPC, name, category, piece and case
// price, a "new" flag and a picture. Costs, vendors, stock and sales stay private.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const auth = require("./auth");

const DIR = path.join(__dirname, "catalog");
const COOKIE = "asi_catalog";
const HOURS = +(process.env.CATALOG_SESSION_HOURS || process.env.SESSION_HOURS || 6);
const password = () => (process.env.CATALOG_PASSWORD || "").trim();
const key = () => crypto.createHash("sha256").update("asi-catalog:" + password()).digest();
const sign = data => crypto.createHmac("sha256", key()).update(data).digest("base64url");

// Wrong passwords per IP: 10 tries per 15 minutes.
const fails = new Map();
function limited(ip) {
  const f = fails.get(ip);
  if (f && Date.now() - f.since > 15 * 60e3) { fails.delete(ip); return false; }
  return !!f && f.n >= 10;
}
const failed = ip => { const f = fails.get(ip) || { n: 0, since: Date.now() }; f.n++; fails.set(ip, f); };

function signedIn(req) {
  const raw = auth.cookies(req)[COOKIE];
  if (!raw || !password()) return false;
  const [data, sig] = raw.split(".");
  if (!data || !sig || !auth.same(sig, sign(data))) return false;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return s.exp > Date.now() && s.dev === auth.device(req);
  } catch { return false; }
}
function setSession(req, res) {
  const exp = Date.now() + HOURS * 3600e3;
  const data = Buffer.from(JSON.stringify({ exp, dev: auth.device(req), id: crypto.randomBytes(9).toString("base64url") })).toString("base64url");
  res.setHeader("set-cookie", `${COOKIE}=${data}.${sign(data)}; Path=/catalog; HttpOnly; SameSite=Lax; Max-Age=${HOURS * 3600}${auth.secure(req) ? "; Secure" : ""}`);
}

function loginPage(res, status, error = "") {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wholesale Catalog · Fragrance Wholesaler USA</title>
<style>
  * { box-sizing: border-box; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5f7; color: #14181f; font: 15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; padding: 16px; }
  form { width: 100%; max-width: 380px; background: #fff; border: 1px solid #dde1e7; border-radius: 12px; padding: 24px; text-align: center; }
  img { width: 220px; max-width: 100%; display: block; margin: -10px auto 4px; }
  h1 { font-size: 18px; margin: 0 0 4px; } p { color: #5d6675; margin: 0 0 16px; font-size: 13px; }
  input { width: 100%; padding: 9px 11px; border: 1px solid #dde1e7; border-radius: 8px; font: inherit; }
  button { width: 100%; margin-top: 12px; padding: 9px; border: 0; border-radius: 8px; background: #111; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .err { color: #c52a2a; margin: 10px 0 0; }
</style></head><body>
<form method="post" action="/catalog/login">
  <img src="/catalog/assets/logo-fwusa.jpg" alt="Fragrance Wholesaler USA">
  <h1>Wholesale Catalog</h1>
  <p>Enter the catalog password. You'll stay signed in on this device for ${HOURS} hours.</p>
  <input type="password" name="password" autocomplete="current-password" placeholder="Password" autofocus required>
  <button type="submit">View catalog</button>
  ${error ? `<p class="err">${auth.esc(error)}</p>` : ""}
</form></body></html>`);
}

// ---- Building the catalog from the products API ----

// Internal SKUs (opened boxes, deleted, discontinued, pallets, supplies) never go to customers.
const HIDDEN = /^(OPEN|DELETED|DISC|DIS\d|DIS$|PALLETS|ROLL OF TAPE)/i;
const HIDDEN_NAME = /^(DELETED|DISCONTINUED)/i;
const SECTIONS = ["PERFUMES", "AIR FRESHNER", "DEODORANT", "CAR PERFUME", "INCENSE", "SUNGLASSES",
  "DIFFUSERS", "COSMETICS", "HEALTH & BEAUTY", "ELECTRONICS", "OTHER"];
// API category → [section, category shown in the catalog]
const CATEGORY = {
  PERFUME: ["PERFUMES", "PERFUME"], VIALS: ["PERFUMES", "PERFUME"], "HAIR MIST": ["PERFUMES", "HAIR MIST"],
  AIRFRESHNER: ["AIR FRESHNER", "AIR FRESHNER"], DEODORANT: ["DEODORANT", "DEODORANT"],
  "CAR AIRFRESHNER": ["CAR PERFUME", "CAR PERFUME"], INCENSE: ["INCENSE", "INCENSE"], BUKHOOR: ["INCENSE", "BUKHOOR"],
  SUNGLASS: ["SUNGLASSES", "SUNGLASSES"], DIFFUSER: ["DIFFUSERS", "DIFFUSER"], COSMETICS: ["COSMETICS", "COSMETICS"],
  HBA: ["HEALTH & BEAUTY", "HEALTH & BEAUTY"], LOTION: ["HEALTH & BEAUTY", "LOTION"], ELECTRONIC: ["ELECTRONICS", "ELECTRONICS"],
};
// For products with no category, go by the SKU prefix; anything else named like a perfume brand is a perfume.
const PREFIX = { AIR: "AIRFRESHNER", DEO: "DEODORANT", CRP: "CAR AIRFRESHNER", INC: "INCENSE", SUN: "SUNGLASS", SGL: "HBA",
  DIF: "DIFFUSER", COS: "COSMETICS", HBA: "HBA", LOT: "LOTION", ELE: "ELECTRONIC" };

const json = s => { if (!s || typeof s !== "string") return null; try { return JSON.parse(s); } catch { return null; } };
const https = u => typeof u === "string" && /^https?:\/\//.test(u) ? u.replace(/^http:/, "https:") : null;
function imageOf(p) {
  const j = json(p.igloo_jomashop), n = json(p.igloo_nocnoc);
  return https(j?.primary_image_url) || https(j?.vendor?.primary_image_url) || https(j?.vendor?.image_urls?.[0])
    || https(n?.images?.[0]?.source_url) || null;
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = n => Math.round(n * 100) / 100;
function addedAt(p) {
  const m = String(p.first_added_date || "").match(/^(\d\d)\/(\d\d)\/(\d{4})$/);
  return m ? Date.parse(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`) : Date.parse(p.created_at || "") || 0;
}

// Price rule (Render → Environment): CATALOG_PRICE=cost shows the API's cost field (the pricing
// workbook's WHOLESALE COST) plus CATALOG_MARKUP_PCT; CATALOG_PRICE=contact shows "Contact Sales".
function priceOf(p) {
  if ((process.env.CATALOG_PRICE || "cost").trim().toLowerCase() === "contact") return null;
  const c = num(p.cost);
  return c > 0 ? round2(c * (1 + num(process.env.CATALOG_MARKUP_PCT) / 100)) : null;
}

// Every API product with its catalog fields. auto: the catalog would include it on its own
// (internal SKUs such as opened boxes, deleted and discontinued are left out unless added by hand).
function build(list) {
  const newDays = num(process.env.CATALOG_NEW_DAYS || 30);
  const byUpc = new Map();
  for (const p of list) { const u = String(p.upc || "").trim(), img = imageOf(p); if (u && img && !byUpc.has(u)) byUpc.set(u, img); }
  const images = new Map(), items = [];
  for (const p of list) {
    const sku = String(p.sku || "").trim();
    if (!sku) continue;
    const auto = !HIDDEN.test(sku) && !HIDDEN_NAME.test(String(p.name || "").trim()) && p.activated !== 0 && p.activated !== "0";
    const upc = String(p.upc || "").trim();
    let cat = String(p.category || "").trim().toUpperCase();
    if (!cat) cat = PREFIX[(sku.match(/^[A-Z]+/i) || [""])[0].toUpperCase()] || "PERFUME";
    const [section, category] = CATEGORY[cat] || ["OTHER", cat];
    const img = imageOf(p) || byUpc.get(upc) || null;
    if (img) images.set(sku, img);
    const qty = Math.round(num(p.qty_in_case));
    items.push({
      sku, upc, name: String(p.name || "").replace(/^\s*\*+\s*/, "").trim(), category, section,
      piece: priceOf(p), qty: qty > 0 ? qty : null, isNew: Date.now() - addedAt(p) < newDays * 864e5, img: !!img, auto,
    });
  }
  items.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku));
  return { items, images };
}

// ---- Settings the owner controls from the dashboard's Customer catalog tab ----
// Saved next to the competitor results, on the Render disk when COMPETITOR_DATA_DIR points there.
const DATA_DIR = process.env.CATALOG_DATA_DIR || process.env.COMPETITOR_DATA_DIR || path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "catalog-settings.json");
const DEFAULTS = { enabled: true, showPrices: true, showCasePrices: true, mode: "all", hidden: [], added: [], prices: {}, updatedAt: null, updatedBy: null };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; } catch {}
const skuList = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean))].slice(0, 10000);
function clean(input, by) {
  const prices = {};
  for (const [k, v] of Object.entries(input.prices && typeof input.prices === "object" ? input.prices : {})) {
    const n = Number(v); if (String(k).trim() && Number.isFinite(n) && n >= 0) prices[String(k).trim()] = round2(n);
  }
  return {
    enabled: input.enabled !== false, showPrices: input.showPrices !== false, showCasePrices: input.showCasePrices !== false,
    mode: input.mode === "selected" ? "selected" : "all", hidden: skuList(input.hidden), added: skuList(input.added), prices,
    updatedAt: new Date().toISOString(), updatedBy: String(by || "").slice(0, 60) || null,
  };
}
function save(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE + ".tmp", JSON.stringify(next, null, 1));
  fs.renameSync(SETTINGS_FILE + ".tmp", SETTINGS_FILE);
  settings = next;
}
// Whether a product shows in the customer catalog under the current settings.
function listed(i, s = settings) {
  if (s.hidden.includes(i.sku)) return false;
  return s.added.includes(i.sku) || (s.mode === "all" && i.auto);
}
function piece(i, s = settings) { return s.prices[i.sku] ?? i.piece; }

let built = { at: 0, data: null };
async function catalog(productList, meta) {
  if (built.data && Date.now() - built.at < 60e3) return built.data;
  const { items, images } = build(await productList());
  built = { at: Date.now(), data: { items, images, sections: SECTIONS, ...meta() } };
  return built.data;
}
// What customers get: only listed products, and prices only when the owner shows them.
function customerView(data) {
  const s = settings, hidden = new Set(s.hidden), added = new Set(s.added);
  const items = data.items.filter(i => !hidden.has(i.sku) && (added.has(i.sku) || (s.mode === "all" && i.auto))).map(i => {
    const p = piece(i, s);
    return { sku: i.sku, upc: i.upc, name: i.name, category: i.category, section: i.section, isNew: i.isNew, img: i.img,
      piece: s.showPrices ? p : undefined, case: s.showCasePrices ? (p != null && i.qty ? round2(p * i.qty) : null) : undefined,
      qty: s.showCasePrices ? i.qty : undefined };
  });
  return { fetchedAt: data.fetchedAt, sections: data.sections, showPrices: s.showPrices, showCasePrices: s.showCasePrices, items };
}

const sendJson = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = req => new Promise((resolve, reject) => {
  let b = ""; req.on("data", c => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { reject(e); } }); req.on("error", reject);
});

// Dashboard side, behind the admin sign-in (auth.gate covers /api/*).
async function handleAdmin(req, res, url, productList, meta) {
  if (url.pathname !== "/api/catalog/settings") return false;
  if (req.method === "POST") {
    let body; try { body = await readJson(req); } catch { return sendJson(res, 400, { error: "Bad JSON" }), true; }
    try { save(clean(body, body.editor)); } catch (e) { return sendJson(res, 500, { error: `Couldn't save: ${e.message}` }), true; }
    console.log(`Catalog settings saved by ${settings.updatedBy || "admin"}: ${settings.enabled ? "on" : "off"}, mode ${settings.mode}, ${settings.hidden.length} removed, ${settings.added.length} added, ${Object.keys(settings.prices).length} price overrides`);
    return sendJson(res, 200, { settings }), true;
  }
  try {
    const data = await catalog(productList, meta);
    sendJson(res, 200, { settings, persistent: !!(process.env.CATALOG_DATA_DIR || process.env.COMPETITOR_DATA_DIR), passwordSet: !!password(),
      fetchedAt: data.fetchedAt, sections: data.sections, items: data.items });
  } catch (e) { sendJson(res, 502, { error: e.message }); }
  return true;
}

function offPage(res) {
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Wholesale Catalog · Fragrance Wholesaler USA</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#14181f;font:15px/1.45 system-ui,sans-serif;padding:16px;text-align:center}img{width:220px;max-width:100%}p{color:#5d6675}</style></head>
<body><div><img src="/catalog/assets/logo-fwusa.jpg" alt="Fragrance Wholesaler USA"><h1 style="font-size:18px">The catalog is unavailable right now</h1><p>Please check back later or call (929) 257-3502.</p></div></body></html>`);
}

async function proxyImage(res, url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "Mozilla/5.0", accept: "image/*" } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) throw new Error(`HTTP ${r.status} ${type}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8e6) throw new Error("too large");
    res.writeHead(200, { "content-type": type, "content-length": buf.length, "cache-control": "private, max-age=86400" });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { "cache-control": "no-store" }); res.end();
  }
}

const ASSET_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

// Returns true when it answered the request.
async function handle(req, res, url, productList, meta) {
  const p = url.pathname;
  if (p !== "/catalog" && !p.startsWith("/catalog/")) return false;
  // Logos are public so the sign-in page can show them.
  if (p.startsWith("/catalog/assets/")) {
    const name = path.basename(p), type = ASSET_TYPES[path.extname(name)];
    if (!type || !/^[\w.-]+$/.test(name)) { res.writeHead(404); res.end(); return true; }
    fs.readFile(path.join(DIR, name), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" }); res.end(data);
    });
    return true;
  }
  if (!password()) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The catalog is locked: set CATALOG_PASSWORD in Render → Environment.");
    return true;
  }
  if (!settings.enabled) {
    if (p === "/catalog" || p === "/catalog/") return offPage(res), true;
    return sendJson(res, 503, { error: "The catalog is turned off." }), true;
  }
  if (p === "/catalog/logout") {
    res.setHeader("set-cookie", `${COOKIE}=; Path=/catalog; HttpOnly; SameSite=Lax; Max-Age=0${auth.secure(req) ? "; Secure" : ""}`);
    res.writeHead(302, { location: "/catalog" }); res.end(); return true;
  }
  if (p === "/catalog/login") {
    if (req.method !== "POST") { res.writeHead(302, { location: "/catalog" }); res.end(); return true; }
    const ip = auth.ipOf(req), form = await auth.readForm(req);
    if (limited(ip)) return loginPage(res, 429, "Too many wrong tries. Wait 15 minutes and try again."), true;
    if (!password() || !auth.same(String(form.password || "").trim(), password())) { failed(ip); return loginPage(res, 401, "That password isn't right."), true; }
    fails.delete(ip); setSession(req, res);
    res.writeHead(303, { location: "/catalog" }); res.end(); return true;
  }
  if (!signedIn(req)) {
    if (p === "/catalog" || p === "/catalog/") return loginPage(res, 200), true;
    res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "Sign in required", login: "/catalog" }));
    return true;
  }
  if (p === "/catalog" || p === "/catalog/") {
    fs.readFile(path.join(DIR, "index.html"), (err, data) => {
      if (err) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" }); res.end(data);
    });
    return true;
  }
  if (p === "/catalog/data") {
    try {
      sendJson(res, 200, customerView(await catalog(productList, meta)));
    } catch (e) {
      console.error(`/catalog/data failed: ${e.message}`);
      res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "The product list couldn't be loaded. Try again in a minute." }));
    }
    return true;
  }
  const m = p.match(/^\/catalog\/img\/([^/]+)$/);
  if (m) {
    const data = await catalog(productList, meta).catch(() => ({ images: new Map(), items: [] }));
    const sku = decodeURIComponent(m[1]), item = data.items.find(i => i.sku === sku);
    const src = item && listed(item) ? data.images.get(sku) : null;
    if (!src) { res.writeHead(404); res.end(); return true; }
    await proxyImage(res, src);
    return true;
  }
  res.writeHead(404); res.end("Not found");
  return true;
}

module.exports = { handle, handleAdmin, build };
