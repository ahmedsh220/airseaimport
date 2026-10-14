// Customer wholesale catalogs, each at its own link with its own password, separate from the admin
// dashboard: Catalog 1 at /catalog (with prices) and Catalog 2 at /catalog2 (without prices by default).
// Built from the live products API on every load, so prices follow the API. Only what the printed
// catalog shows leaves the server: SKU, UPC, name, category, piece and case price, a "new" flag and a
// picture. Costs, vendors, stock and sales stay private. The owner controls both from the dashboard's
// Catalog management page (public/catalog-admin.html).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const auth = require("./auth");

const DIR = path.join(__dirname, "..", "catalog");
const HOURS = +(process.env.CATALOG_SESSION_HOURS || process.env.SESSION_HOURS || 6);
const CATALOGS = {
  1: { id: "1", name: "Catalog 1", base: "/catalog", cookie: "asi_catalog", env: "CATALOG_PASSWORD",
    defaults: { showPrices: true, showCasePrices: true } },
  2: { id: "2", name: "Catalog 2", base: "/catalog2", cookie: "asi_catalog2", env: "CATALOG2_PASSWORD",
    defaults: { showPrices: false, showCasePrices: false } },
};

// A password set from the dashboard (stored hashed) wins over the one in Render's environment.
const envPassword = c => (process.env[c.env] || "").trim();
const hasPassword = c => !!(settingsOf(c).passwordHash || envPassword(c));
function checkPassword(c, given) {
  const s = settingsOf(c), g = String(given || "").trim();
  if (!g) return false;
  if (s.passwordHash) {
    const [salt, hash] = s.passwordHash.split(":");
    return auth.same(crypto.scryptSync(g, salt, 32).toString("hex"), hash);
  }
  return !!envPassword(c) && auth.same(g, envPassword(c));
}
const hashPassword = pw => { const salt = crypto.randomBytes(12).toString("hex"); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`; };
// Sessions are signed with a key tied to the catalog's current password, so changing it signs everyone out.
const key = c => crypto.createHash("sha256").update(`asi-catalog${c.id}:` + (settingsOf(c).passwordHash || envPassword(c))).digest();
const sign = (c, data) => crypto.createHmac("sha256", key(c)).update(data).digest("base64url");

// Wrong passwords per IP: 10 tries per 15 minutes, across both catalogs.
const fails = new Map();
function limited(ip) {
  const f = fails.get(ip);
  if (f && Date.now() - f.since > 15 * 60e3) { fails.delete(ip); return false; }
  return !!f && f.n >= 10;
}
const failed = ip => { const f = fails.get(ip) || { n: 0, since: Date.now() }; f.n++; fails.set(ip, f); };

function signedIn(c, req) {
  const raw = auth.cookies(req)[c.cookie];
  if (!raw || !hasPassword(c)) return false;
  const [data, sig] = raw.split(".");
  if (!data || !sig || !auth.same(sig, sign(c, data))) return false;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return s.exp > Date.now() && s.dev === auth.device(req) && s.cat === c.id;
  } catch { return false; }
}
function setSession(c, req, res) {
  const exp = Date.now() + HOURS * 3600e3;
  const data = Buffer.from(JSON.stringify({ exp, cat: c.id, dev: auth.device(req), id: crypto.randomBytes(9).toString("base64url") })).toString("base64url");
  res.setHeader("set-cookie", `${c.cookie}=${data}.${sign(c, data)}; Path=${c.base}; HttpOnly; SameSite=Lax; Max-Age=${HOURS * 3600}${auth.secure(req) ? "; Secure" : ""}`);
}

function loginPage(c, res, status, error = "") {
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
<form method="post" action="${c.base}/login">
  <img src="/media/logo-fwusa.jpg" alt="Fragrance Wholesaler USA">
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

// Wholesale cost from the API (the pricing workbook's WHOLESALE COST). The API has no selling price,
// so each catalog's prices are this cost plus the markups set in Catalog management.
const costOf = p => { const c = num(p.cost); return c > 0 ? c : null; };

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
      cost: costOf(p), qty: qty > 0 ? qty : null, isNew: Date.now() - addedAt(p) < newDays * 864e5, img: !!img, auto,
    });
  }
  items.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku));
  return { items, images };
}

// ---- Settings the owner controls from the dashboard's Catalog management page, one set per catalog ----
// Saved next to the competitor results, on the Render disk when COMPETITOR_DATA_DIR points there.
const DATA_DIR = process.env.CATALOG_DATA_DIR || process.env.COMPETITOR_DATA_DIR || path.join(__dirname, "..", "data");
const SETTINGS_FILE = path.join(DATA_DIR, "catalog-settings.json");
// Wholesale pricing rules: piece price = cost + pieceMarkupPct, case price (per piece) = cost + caseMarkupPct,
// with the piece and per-piece case prices rounded up to the next roundTo (0 = no rounding).
const BASE = { enabled: true, pieceMarkupPct: 12, caseMarkupPct: 8, roundTo: 0.5, mode: "all", hidden: [], added: [], prices: {}, passwordHash: null, updatedAt: null, updatedBy: null };
const fresh = c => ({ ...BASE, ...c.defaults });
let store = {};
try {
  const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  store = "enabled" in raw ? { 1: raw } : raw; // the first version saved Catalog 1's settings at the top level
} catch {}
const settingsOf = c => ({ ...fresh(c), ...(store[c.id] || {}) });
const skuList = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean))].slice(0, 10000);
function clean(c, input, by) {
  const prices = {};
  for (const [k, v] of Object.entries(input.prices && typeof input.prices === "object" ? input.prices : {})) {
    const n = Number(v); if (String(k).trim() && Number.isFinite(n) && n >= 0) prices[String(k).trim()] = round2(n);
  }
  const pw = typeof input.newPassword === "string" ? input.newPassword.trim() : "";
  const pct = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= -100 && n <= 1000 ? round2(n) : d; };
  return {
    enabled: input.enabled !== false, pieceMarkupPct: pct(input.pieceMarkupPct, BASE.pieceMarkupPct), caseMarkupPct: pct(input.caseMarkupPct, BASE.caseMarkupPct),
    roundTo: [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1].includes(Number(input.roundTo)) ? Number(input.roundTo) : BASE.roundTo,
    showPrices: input.showPrices === true, showCasePrices: input.showCasePrices === true,
    mode: input.mode === "selected" ? "selected" : "all", hidden: skuList(input.hidden), added: skuList(input.added), prices,
    passwordHash: pw ? hashPassword(pw) : input.clearPassword ? null : settingsOf(c).passwordHash,
    updatedAt: new Date().toISOString(), updatedBy: String(by || "").slice(0, 60) || null,
  };
}
function save(c, next) {
  const all = { ...store, [c.id]: next };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE + ".tmp", JSON.stringify(all, null, 1));
  fs.renameSync(SETTINGS_FILE + ".tmp", SETTINGS_FILE);
  store = all;
}
// Whether a product shows in the catalog under its settings.
// Prices under a catalog's rules. A price set for the SKU in Catalog management replaces the piece price.
function pricesFor(i, s) {
  const rnd = n => s.roundTo > 0 ? round2(Math.ceil(n / s.roundTo - 1e-9) * s.roundTo) : round2(n);
  const piece = s.prices[i.sku] ?? (i.cost != null ? rnd(i.cost * (1 + s.pieceMarkupPct / 100)) : null);
  const unit = i.cost != null ? rnd(i.cost * (1 + s.caseMarkupPct / 100)) : null;
  return { piece, caseUnit: unit };
}
const listed = (i, s) => !s.hidden.includes(i.sku) && (s.added.includes(i.sku) || (s.mode === "all" && i.auto));
// What the dashboard sees of a catalog's settings: everything but the password hash.
function publicSettings(c) {
  const { passwordHash, ...s } = settingsOf(c);
  return { ...s, name: c.name, url: c.base, password: passwordHash ? "dashboard" : envPassword(c) ? "render" : null, passwordEnv: c.env };
}

let built = { at: 0, data: null };
async function catalog(productList, meta) {
  if (built.data && Date.now() - built.at < 60e3) return built.data;
  const { items, images } = build(await productList());
  built = { at: Date.now(), data: { items, images, sections: SECTIONS, ...meta() } };
  return built.data;
}
// What customers get: only listed products, and prices only when the owner shows them.
function customerView(c, data) {
  const s = settingsOf(c), hidden = new Set(s.hidden), added = new Set(s.added);
  const items = data.items.filter(i => !hidden.has(i.sku) && (added.has(i.sku) || (s.mode === "all" && i.auto))).map(i => {
    const pr = pricesFor(i, s);
    return { sku: i.sku, upc: i.upc, name: i.name, category: i.category, section: i.section, isNew: i.isNew, img: i.img,
      piece: s.showPrices ? pr.piece : undefined,
      caseUnit: s.showCasePrices ? pr.caseUnit : undefined, qty: i.qty };
  });
  return { catalog: c.name, fetchedAt: data.fetchedAt, sections: data.sections, showPrices: s.showPrices, showCasePrices: s.showCasePrices, items };
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
    const c = CATALOGS[body.catalog];
    if (!c) return sendJson(res, 400, { error: "Unknown catalog" }), true;
    if (typeof body.newPassword === "string" && body.newPassword.trim() && body.newPassword.trim().length < 6)
      return sendJson(res, 400, { error: "Use a password of at least 6 characters." }), true;
    try { save(c, clean(c, body, body.editor)); } catch (e) { return sendJson(res, 500, { error: `Couldn't save: ${e.message}` }), true; }
    const s = settingsOf(c);
    console.log(`${c.name} settings saved by ${s.updatedBy || "admin"}: ${s.enabled ? "on" : "off"}, prices ${s.showPrices ? "shown" : "hidden"}, case prices ${s.showCasePrices ? "shown" : "hidden"}, mode ${s.mode}, ${s.hidden.length} removed, ${s.added.length} added, ${Object.keys(s.prices).length} price overrides${body.newPassword ? ", password changed" : ""}`);
    return sendJson(res, 200, { settings: publicSettings(c) }), true;
  }
  try {
    const data = await catalog(productList, meta);
    sendJson(res, 200, { catalogs: Object.fromEntries(Object.values(CATALOGS).map(c => [c.id, publicSettings(c)])),
      persistent: !!(process.env.CATALOG_DATA_DIR || process.env.COMPETITOR_DATA_DIR),
      fetchedAt: data.fetchedAt, sections: data.sections, items: data.items });
  } catch (e) { sendJson(res, 502, { error: e.message }); }
  return true;
}

function offPage(res) {
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Wholesale Catalog · Fragrance Wholesaler USA</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#14181f;font:15px/1.45 system-ui,sans-serif;padding:16px;text-align:center}img{width:220px;max-width:100%}p{color:#5d6675}</style></head>
<body><div><img src="/media/logo-fwusa.jpg" alt="Fragrance Wholesaler USA"><h1 style="font-size:18px">The catalog is unavailable right now</h1><p>Please check back later or call (929) 257-3502.</p></div></body></html>`);
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


// Returns true when it answered the request.
async function handle(req, res, url, productList, meta) {
  const p = url.pathname;
  const c = Object.values(CATALOGS).find(c => p === c.base || p.startsWith(c.base + "/"));
  if (!c) return false;
  const sub = p.slice(c.base.length) || "/";
  if (!hasPassword(c)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${c.name} is locked: set its password on the dashboard's Catalog management page.`);
    return true;
  }
  if (!settingsOf(c).enabled) {
    if (sub === "/") return offPage(res), true;
    return sendJson(res, 503, { error: "The catalog is turned off." }), true;
  }
  if (sub === "/logout") {
    res.setHeader("set-cookie", `${c.cookie}=; Path=${c.base}; HttpOnly; SameSite=Lax; Max-Age=0${auth.secure(req) ? "; Secure" : ""}`);
    res.writeHead(302, { location: c.base }); res.end(); return true;
  }
  if (sub === "/login") {
    if (req.method !== "POST") { res.writeHead(302, { location: c.base }); res.end(); return true; }
    const ip = auth.ipOf(req), form = await auth.readForm(req);
    if (limited(ip)) return loginPage(c, res, 429, "Too many wrong tries. Wait 15 minutes and try again."), true;
    if (!checkPassword(c, form.password)) { failed(ip); return loginPage(c, res, 401, "That password isn't right."), true; }
    fails.delete(ip); setSession(c, req, res);
    res.writeHead(303, { location: c.base }); res.end(); return true;
  }
  if (!signedIn(c, req)) {
    if (sub === "/") return loginPage(c, res, 200), true;
    return sendJson(res, 401, { error: "Sign in required", login: c.base }), true;
  }
  if (sub === "/") {
    fs.readFile(path.join(DIR, "index.html"), (err, data) => {
      if (err) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" }); res.end(data);
    });
    return true;
  }
  if (sub === "/data") {
    try {
      sendJson(res, 200, customerView(c, await catalog(productList, meta)));
    } catch (e) {
      console.error(`${p} failed: ${e.message}`);
      sendJson(res, 502, { error: "The product list couldn't be loaded. Try again in a minute." });
    }
    return true;
  }
  const m = sub.match(/^\/img\/([^/]+)$/);
  if (m) {
    const data = await catalog(productList, meta).catch(() => ({ images: new Map(), items: [] }));
    const sku = decodeURIComponent(m[1]), item = data.items.find(i => i.sku === sku);
    const src = item && listed(item, settingsOf(c)) ? data.images.get(sku) : null;
    if (!src) { res.writeHead(404); res.end(); return true; }
    await proxyImage(res, src);
    return true;
  }
  res.writeHead(404); res.end("Not found");
  return true;
}

module.exports = { handle, handleAdmin, build };
