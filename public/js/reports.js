// =====================================================================================================
// reports.js: the reports page (public/index.html). Everything is computed here, in the browser, from the
// products API list, so each number on screen can be traced to a formula below.
//
// How it fits together
//   load()       fetches the products (browser → API first, then our server's copy, then the copy saved in
//                this browser) and hands them to ingest()
//   enrich()     turns one API product into a row with the spreadsheet's metrics (_qoh, _day, _Q, _pl, …)
//   apply()      applies the top bar filters (search, category, tier) to all products → rows
//   render()     draws the current view (ST.tab) from rows; each view has a <name>Html() function
//   table()      the dynamic table every view uses: sort, pagination, totals, hidden columns, CSV export
//   events       one click and one change listener at the bottom route every button by its data-* attribute
//
// State: ST (current view, platform, filters, per-view choices) and SET (the sheet's numbers) are saved in
// localStorage, so the page opens where it was left. See "What the browser stores" in the README.
// =====================================================================================================

const API = location.protocol.startsWith("http") ? "/api/products" : "https://hub.fragrancewholesalerusa.com/api/open/products";

const num = v => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,]/g, "")); return isFinite(n) ? n : null; };
const n0 = v => num(v) ?? 0;
const pos = v => { const n = num(v); return n != null && n > 0 ? n : null; };
const json = v => { if (!v) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };
function parseDate(v) {
  if (!v) return null;
  // Parsed by hand: Safari rejects "…T17:40:23.000000Z" (6-digit fractions) and "YYYY-MM-DD HH:MM:SS".
  const s = String(v), us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return new Date(+us[3], us[1] - 1, +us[2]);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/);
  if (!m) return null;
  const [, y, mo, d, h = 0, mi = 0, sec = 0, tz] = m;
  if (!tz) return new Date(+y, mo - 1, +d, +h, +mi, +sec);
  const utc = Date.UTC(+y, mo - 1, +d, +h, +mi, +sec);
  if (tz === "Z") return new Date(utc);
  const sign = tz[0] === "-" ? -1 : 1, off = tz.slice(1).replace(":", "");
  return new Date(utc - sign * (+off.slice(0, 2) * 60 + +off.slice(2)) * 60000);
}
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtInt = v => v == null ? "—" : Math.round(v).toLocaleString();
const fmt1 = v => v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const fmtUsd = v => v == null ? "—" : v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
const fmtPct = v => v == null ? "—" : (v * 100).toFixed(1) + "%";
const fmtDate = v => { const d = v instanceof Date ? v : parseDate(v); return d ? d.toLocaleDateString() : "—"; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = id => document.getElementById(id);
const sum = (list, f) => list.reduce((a, r) => a + (f(r) || 0), 0);

// Sales channels: the API's *_60_days columns (the Excel "PLATFORMS SALES TRACKING (60 DAYS)" block).
const CHANNELS = { tt: "TikTok", amaz: "Amazon", wmt: "Walmart", temu: "Temu", fair: "Faire", noc: "NocNoc", shn: "Shein",
  ebay: "eBay", joma: "Jomashop", shopify: "Shopify", posh: "Poshmark", seebiz: "SeeBiz", whatnot: "Whatnot", wholesale: "Wholesale" };
const VENDORS = { perfume_trading_center: "Perfume Trading Center", perfume_plus: "Perfume Plus", al_hussein: "Al Hussein",
  br: "B&R", edge: "Edge", fragsense: "Fragsense", french_perfumes: "French Perfumes", giftexpress: "GiftExpress",
  legacy: "Legacy", lux: "Lux", perfume_center_america: "Perfume Center America", perfume_of_the_world: "Perfume of the World",
  azmere: "Azmere", tahir: "Tahir", nandanson: "Nandanson", bs: "BS", mb: "MB", universal: "Universal", tjs: "TJs",
  et_perfumes: "ET Perfumes", miami_trading: "Miami Trading", cosmo: "Cosmo" };
const vendorDateKey = k => k === "perfume_trading_center" ? "perfume_trading_center__date" : k + "_date";

// Excel helpers
const INT = Math.floor;
const CEILING = (x, s) => Math.ceil(x / s - 1e-9) * s;
const ROUNDUP = x => Math.ceil(x - 1e-9);
const end99 = x => INT(x) + 0.99;

// Platform P&L, copied from the Excel sheet. c.Q = TOTAL COST TO SHIP (final_cost), c.AN = PLATFORM COST,
// c.AG = SHIP CHARGE (ship_cost), c.AS = WHOLESALE COST (cost). PFT% = 1 − cost / (cost + profit), as in the sheet.
const PL = [
  { k: "tiktok", ch: "tt", label: "TikTok", rule: "20% fee, we pay ship when price ≥ $30", formula: "entered price",
    price: null, fee: p => p * 0.2, ship: (p, c) => p < 30 ? 0 : c.AG },
  { k: "amazon", ch: "amaz", label: "Amazon", rule: "15% fee + ship", formula: "INT(Q×1.25 + ship) + .99",
    price: c => end99(c.Q * 1.25 + c.AG), fee: p => p * 0.15, ship: (p, c) => c.AG },
  { k: "walmart", ch: "wmt", label: "Walmart", rule: "15% fee + ship", formula: "INT(Q×1.5 + ship) + .99",
    price: c => end99(c.Q * 1.5 + c.AG), fee: p => p * 0.15, ship: (p, c) => c.AG },
  { k: "temu", ch: "temu", label: "Temu", rule: "no fee, we pay ship", formula: "(Q + ship + 18%) to nearest .25",
    price: c => Math.round((c.Q + c.AG + c.Q * 0.18) * 4) / 4, fee: () => 0, ship: (p, c) => c.AG },
  { k: "faire", ch: "fair", label: "Faire", rule: "19% fee, no ship, on platform cost", formula: "CEILING(wholesale × 1.364, .25)",
    price: c => c.AS ? CEILING(c.AS * 1.364, 0.25) : null, fee: p => p * 0.19, ship: () => 0, base: "AN" },
  { k: "nocnoc", ch: "noc", label: "NocNoc", rule: "7% fee, no ship", formula: "ROUNDUP(Q × 1.29)",
    price: c => ROUNDUP(c.Q * 1.29), fee: p => p * 0.07, ship: () => 0 },
  { k: "shein", ch: "shn", label: "Shein", rule: "12% fee + ship", formula: "INT(Q × 1.7) + .99",
    price: c => end99(c.Q * 1.7), fee: p => p * 0.12, ship: (p, c) => c.AG },
  { k: "ebay", ch: "ebay", label: "eBay", rule: "12.7% + $0.40 fee + ship", formula: "INT(Q × 1.72) + .99",
    price: c => end99(c.Q * 1.72), fee: p => p * 0.127 + 0.4, ship: (p, c) => c.AG },
  { k: "jomashop", ch: "joma", label: "Jomashop", rule: "no fee, profit on platform cost", formula: "CEILING(Q × 1.17, .5)",
    price: c => CEILING(c.Q * 1.17, 0.5), fee: () => 0, ship: () => 0, base: "AN", pctBase: "Q" },
  { k: "shopify", ch: "shopify", label: "Shopify", rule: "2.75% + $0.20 fee + ship", formula: "INT(Q × 1.6) + .99",
    price: c => end99(c.Q * 1.6), fee: p => p * 0.0275 + 0.2, ship: (p, c) => c.AG },
  { k: "poshmark", ch: "posh", label: "Poshmark", rule: "20% fee ($2.95 at $15 or less)", formula: "INT(Q × 1.55) + 1",
    price: c => INT(c.Q * 1.55) + 1, fee: p => p <= 15 ? 2.95 : p * 0.2, ship: () => 0 },
  { k: "whatnot", ch: "whatnot", label: "Whatnot", rule: "11% + $0.30 fee, no ship", formula: "INT(Q × 1.42) + .99",
    price: c => end99(c.Q * 1.42), fee: p => p * 0.11 + 0.3, ship: () => 0 },
];
const PL_BY_CH = Object.fromEntries(PL.map(x => [x.ch, x]));

// Settings from the Excel sheet; editable on the page and remembered in this browser.
const SETTING_DEFAULTS = { window: 80, mult: 45, trigger: 28, minMargin: 18, misc: 0.05, livePrices: false };
let SET = (() => { try { return { ...SETTING_DEFAULTS, ...JSON.parse(localStorage.getItem("asi-v4-settings") || "{}") }; } catch { return { ...SETTING_DEFAULTS }; } })();
const saveSettings = () => { try { localStorage.setItem("asi-v4-settings", JSON.stringify(SET)); } catch {} };

// ---------- per-product metrics (Excel column letters in comments) ----------
function enrich(p) {
  const qoh = n0(p.live_qoh ?? p.qoh);                          // M  LIVE INV
  const inProg = n0(p.in_progress);                             // CQ ORDERED
  const caseQty = pos(p.qty_in_case);                           // AB QTY IN CASE
  const box = n0(p.box_cost), AG = n0(p.ship_cost);             // AH BOX COST, AG SHIP CHARGE
  const purchase = pos(p.actual_cost) ?? pos(p.purchase_cost) ?? pos(p.cost);
  const Q = pos(p.final_cost) ?? (purchase != null ? purchase + box + SET.misc : null); // Q TOTAL COST TO SHIP
  const AN = Q != null ? Math.max(0, Q - box - SET.misc) : null;                     // AN PLATFORM COST
  const AS = pos(p.cost);                                       // AS WHOLESALE COST
  const sold = n0(p.sales_90_days);                             // BI SOLD IN WINDOW
  const day = sold / SET.window;                                // BM DAY AVE
  const monthly = day * 30;                                     // BO MONTHLY SOLD
  const days = day > 0 ? qoh / day : null;                      // L  DAYS OF STOCK
  const ch = {}; let ch60 = 0;
  for (const k in CHANNELS) { const v = n0(p[k + "_60_days"]); ch[k] = v; ch60 += v; }  // BQ..CF, CG SOLD 60 DAYS
  const topCh = Object.keys(ch).sort((a, b) => ch[b] - ch[a]).find(k => ch[k] > 0) || null;
  // Reorder, as in the sheet: trigger when INT(days of stock) ≤ 28, order DAY AVE × 45 − LIVE INV − ORDERED, in whole cases.
  const trigger = day > 0 && INT(qoh / day) <= SET.trigger;
  const need = trigger ? Math.max(0, day * SET.mult - qoh - inProg) : 0;      // CM
  const cases = need > 0 ? (caseQty ? ROUNDUP(need / caseQty) : null) : 0;    // CU CASES ORDER
  const orderQty = need > 0 ? (caseQty ? cases * caseQty : ROUNDUP(need)) : 0; // CW ORDER QTY
  const prices = [];
  for (const k in VENDORS) { const v = pos(p[k]); if (v != null) prices.push({ k, price: v, date: parseDate(p[vendorDateKey(k)]) }); }
  prices.sort((a, b) => a.price - b.price);
  const r = { ...p, _qoh: qoh, _inProg: inProg, _caseQty: caseQty, _box: box, _AG: AG, _Q: Q, _AN: AN, _AS: AS,
    _sold: sold, _returns: n0(p.returns_90_days), _day: day, _hiDay: n0(p.sales_highest_avg_90_days) / 90, _monthly: monthly, _days: days,
    _needMonth: monthly - qoh,                                  // CH NEED MORE FOR MONTH
    _casesHand: caseQty ? qoh / caseQty : null,                 // BF CASES HAND
    _value: AN != null ? AN * Math.max(0, qoh) : 0,             // BG STOCK VALUE
    _rop: day * SET.trigger,                                    // reorder point in units
    _trigger: trigger, _need: need, _cases: cases, _orderQty: orderQty, _orderCost: AN != null ? orderQty * AN : null, // CX
    _ch: ch, _ch60: ch60, _topCh: topCh,
    _prices: prices, _best: prices[0]?.price ?? null, _bestVendor: prices[0]?.k ?? null,
    _vendor: (p.current_vendor || "").trim() || "No vendor set",
    _tier: (p.pricing_category || "").toLowerCase() || "none" };
  r._live = livePrices(p);
  computePL(r);
  return r;
}
function livePrices(p) {
  const igloo = json(p.igloo) || {}, tt = json(p.igloo_tiktok), az = json(p.igloo_amazon), noc = json(p.igloo_nocnoc), sh = json(p.igloo_shopify);
  const out = {
    tiktok: pos(igloo.tiktok?.sell_price) ?? pos(p.tiktok_same_price) ?? pos(tt?.skus?.[0]?.price?.tax_exclusive_price),
    amazon: pos(az?.price) ?? pos(igloo.amazon?.sell_price),
    nocnoc: pos(noc?.price) ?? pos(igloo.nocnoc?.sell_price),
    shopify: pos(sh?.price) ?? pos(igloo.shopify?.sell_price),
  };
  for (const x of PL) if (out[x.k] == null) out[x.k] = pos(igloo[x.k]?.sell_price);
  return out;
}
function computePL(r) {
  r._pl = {};
  const c = { Q: r._Q, AN: r._AN, AG: r._AG, AS: r._AS };
  for (const x of PL) {
    const live = r._live[x.k], formula = c.Q != null && x.price ? x.price(c) : null;
    const price = x.k === "tiktok" ? live : (SET.livePrices && live != null ? live : formula);
    const src = x.k === "tiktok" ? "TikTok price" : SET.livePrices && live != null ? "live listing" : "Excel formula";
    if (price == null || c.Q == null) { r._pl[x.k] = { price: null, live, src }; continue; }
    const fee = x.fee(price), ship = x.ship(price, c), base = c[x.base || "Q"], pctBase = c[x.pctBase || x.base || "Q"];
    const profit = price - fee - ship - base;
    const units = r._ch[x.ch] || 0;
    r._pl[x.k] = { price, live, src, fee, ship, base, profit, pct: pctBase + profit ? profit / (pctBase + profit) : null, units, profit60: profit * units };
  }
}
// Last good copy kept in the browser (IndexedDB) so a server or API hiccup still shows data.
const idb = (mode, fn) => new Promise((resolve, reject) => {
  const open = indexedDB.open("asi-dashboard", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => { const tx = open.result.transaction("kv", mode), req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); };
});
const saveSnapshot = text => idb("readwrite", s => s.put({ at: Date.now(), text }, "products")).catch(() => {});
const loadSnapshot = () => idb("readonly", s => s.get("products")).catch(() => null);

const UPSTREAM = "https://hub.fragrancewholesalerusa.com/api/open/products";
// The API loads fine in a browser but gets cut off when our server fetches it, so the browser
// asks the API directly first and only uses our server's copy if the browser isn't allowed to.
let directError = "";
async function fetchProducts(force) {
  directError = "";
  if (API !== UPSTREAM) {
    try {
      setStatus("Fetching products from the API…");
      const res = await fetch(UPSTREAM, { cache: "no-store", signal: AbortSignal.timeout(45000) });
      if (res.ok) { const text = await res.text(); JSON.parse(text); viaSource = "live API"; return text; }
    } catch (e) { console.warn("Direct API fetch failed, using the server copy", e); directError = e.name === "SyntaxError" ? "the API's response was cut off (incomplete JSON)" : e.message; }
  }
  try { return await fetchVia(API, force); }
  catch (e) { throw new Error(`direct: ${directError || "n/a"}; server: ${e.message}`); }
}
let viaSource = "live API";
async function fetchVia(API, force) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      setStatus(`Direct load failed, trying the server copy (attempt ${attempt} of 2)…`);
      const res = await fetch(API + (force && API.startsWith("/") ? "?refresh=1" : ""), { cache: "no-store", signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      viaSource = res.headers.get("x-source") === "stale"
        ? `last good copy from ${new Date(res.headers.get("x-fetched-at")).toLocaleString()} (the live API isn't answering right now)`
        : `live API via server, fetched ${new Date(res.headers.get("x-fetched-at") || Date.now()).toLocaleTimeString()}`;
      return await res.text();
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw last;
}
async function load(force) {
  setStatus("Fetching products…");
  try {
    const text = await fetchProducts(force);
    const data = JSON.parse(text);
    ingest(data, viaSource);
    saveSnapshot(text);
  } catch (e) {
    console.error(e);
    const snap = await loadSnapshot();
    if (snap?.text) {
      ingest(JSON.parse(snap.text), `saved copy from ${new Date(snap.at).toLocaleString()} (live API unavailable: ${e.message}, try Refresh data)`);
      return;
    }
    setStatus(`<div class="err">Couldn't load the products API (${esc(e.message)}).</div>
      Try <b>Refresh data</b> in a minute.`);
  }
}

// ---------- state ----------
let all = [], rows = [], charts = {}, SOURCE = "", LOADED = null;
const ST = (() => {
  const d = { tab: "overview", plat: "", cat: "", tier: "", horizon: 30, group: "vendor", show: "order", groupPick: null, plFilter: "all",
    vendor: "", cover: 90, vf: "all", masterFilter: "", soldShow: "sold", compFilter: "all" };
  let s; try { s = { ...d, ...JSON.parse(localStorage.getItem("asi-v4-state") || "{}"), groupPick: null, vendor: "" }; } catch { s = d; }
  if (![7, 14, 30, 60].includes(s.horizon)) s.horizon = 30;   // 60 days is the longest period the API has per platform
  s.tab = shell.OLD_VIEWS[s.tab] || s.tab;                     // "sheet" and "actions" were renamed
  return s; })();
const saveState = () => { try { localStorage.setItem("asi-v4-state", JSON.stringify(ST)); } catch {} };
let query = "";                 // search box text (not saved)
const SORT = {}, TABLES = {};   // per table id: current sort, and the rows/columns last drawn (for clicks and CSV)
let settingsOpen = false;       // "Change the sheet's numbers" panel on Reorder stays open across redraws
let lastTable = null;           // the view's main table, for Export CSV

function ingest(data, source) {
  const list = Array.isArray(data) ? data : (data.data || data.products || data.items || []);
  all = [];
  let bad = 0;
  for (const p of list) { try { all.push(enrich(p)); } catch (e) { bad++; console.warn("Skipped product", p?.sku, e); } }
  if (!all.length) { setStatus(`<p class="bad">The API answered but no products could be read (${list.length} records, ${bad} failed).</p>`); return; }
  SOURCE = source; LOADED = new Date();
  $("status").hidden = true; $("app").hidden = false;
  apply();
}
function reEnrich() { all = all.map(r => enrich(r)); apply(); }
function setStatus(html) { const s = $("status"); s.innerHTML = html; s.hidden = false; }
// Top bar filters → rows. The platform filter isn't applied here: each view decides what "on this platform" means.
function apply() {
  const q = query.trim().toLowerCase();
  rows = all.filter(r => (!ST.cat || r.category === ST.cat) && (!ST.tier || r._tier === ST.tier)
    && (!q || [r.sku, r.name, r.upc].some(x => String(x ?? "").toLowerCase().includes(q))));
  render();
}

// ---------- sales data ----------
// The products API has fixed counts only: an all-platform 90-day total (sales_90_days, used by the sheet's
// reorder math) and per-platform 60-day columns. Nothing on the page estimates past sales.
const PERIODS = [7, 14, 30, 60];
const apiSyncedAt = () => { let m = 0; for (const r of all) { const d = parseDate(r.updated_at); if (d && +d > m) m = +d; } return m ? new Date(m) : null; };
// Where the numbers come from, at the bottom of the side navigation.
function renderFoot() {
  const el = $("navFoot"); if (!el) return;
  const synced = apiSyncedAt(), short = d => d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  el.innerHTML = [`<b>${fmtInt(all.length)}</b> products · API updated ${synced ? short(synced) : "unknown"}`,
    SOURCE && !/^live API/.test(SOURCE) ? `<span class=warn>${esc(SOURCE)}</span>` : null].filter(Boolean).map(x => `<div>${x}</div>`).join("");
}

// ---------- top bar: Platform, Category and Tier menus, and the search box ----------
// The triggers live in the shell's #topFilters slot; picking an option updates ST and redraws the view.
const TIER_ORDER = ["super", "hero", "green", "reg", "new", "breathing", "empty", "dead"];
function renderFilters() {
  const el = $("topFilters"); if (!el) return;
  const plat = ST.plat ? `${platformLogo(ST.plat)} ${esc(CHANNELS[ST.plat])}` : "All";
  const tier = ST.tier ? `<span class="dot" style="--c:var(${tierVar(ST.tier)})"></span> ${esc(ST.tier)}` : "All";
  el.innerHTML = ui.selectTrigger("fPlat", "Platform", plat, !!ST.plat) + ui.selectTrigger("fCat", "Category", ST.cat ? esc(ST.cat) : "All", !!ST.cat)
    + ui.selectTrigger("fTier", "Tier", tier, !!ST.tier)
    // Reset shows only while something narrows the view: a filter, the search, or an Overview tile's filter.
    + (ST.plat || ST.cat || ST.tier || query.trim() || ST.masterFilter
      ? `<button type="button" class="subtle" id="resetFilters" title="Clear the filters and the search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg><span>Reset</span></button>` : "");
  for (const b of el.querySelectorAll(".dd-trigger .val")) b.style.display = "inline-flex", b.style.alignItems = "center", b.style.gap = "6px";
}
// Menu options, each with its count among the products the other filters leave.
function platformOptions() {
  const list = Object.keys(CHANNELS).map(k => ({ value: k, label: CHANNELS[k], icon: platformLogo(k), u: sum(rows, r => r._ch[k]) })).sort((a, b) => b.u - a.u);
  return [{ value: "", label: "All platforms", icon: platformLogo(""), meta: fmtInt(sum(rows, r => r._ch60)) + " sold" },
    ...list.map(x => ({ ...x, meta: fmtInt(x.u) + " sold" }))];
}
function countOptions(key, all_, label, icon) {
  const n = new Map(); for (const r of all_) n.set(key(r), (n.get(key(r)) || 0) + 1);
  return [{ value: "", label, meta: fmtInt(all_.length) }, ...[...n].filter(([k]) => k).map(([k, c]) => ({ value: k, label: k, meta: fmtInt(c), icon: icon?.(k) }))];
}
function openFilter(id) {
  const t = $(id), q = query.trim().toLowerCase(), byQ = r => !q || [r.sku, r.name, r.upc].some(x => String(x ?? "").toLowerCase().includes(q));
  if (id === "fPlat") ui.selectMenu(t, platformOptions(), ST.plat, v => { ST.plat = v; ST.groupPick = null; render(); });
  if (id === "fCat") ui.selectMenu(t, countOptions(r => r.category, all.filter(r => byQ(r) && (!ST.tier || r._tier === ST.tier)), "All categories").sort((a, b) => !a.value ? -1 : !b.value ? 1 : a.label.localeCompare(b.label)), ST.cat, v => { ST.cat = v; apply(); });
  if (id === "fTier") {
    const opts = countOptions(r => r._tier === "none" ? "" : r._tier, all.filter(r => byQ(r) && (!ST.cat || r.category === ST.cat)), "All tiers", k => `<span class="dot" style="--c:var(${tierVar(k)})"></span>`);
    opts.sort((a, b) => !a.value ? -1 : !b.value ? 1 : (TIER_ORDER.indexOf(a.value) + 1 || 99) - (TIER_ORDER.indexOf(b.value) + 1 || 99));
    ui.selectMenu(t, opts, ST.tier, v => { ST.tier = v; apply(); });
  }
}
// Search box: typing filters the current view (after a short pause) and opens a dropdown of the best-matching
// products. Picking one puts its SKU in the box and opens that product's detail. ↓ moves into the list, Esc closes it.
const matches = q => {
  q = q.trim().toLowerCase(); if (!q) return [];
  const score = r => { const k = String(r.sku ?? "").toLowerCase(), n = String(r.name ?? "").toLowerCase();
    return k === q || String(r.upc ?? "") === q ? 0 : k.startsWith(q) ? 1 : n.startsWith(q) || n.includes(" " + q) ? 2 : 3; };
  return all.filter(r => [r.sku, r.name, r.upc].some(x => String(x ?? "").toLowerCase().includes(q)))
    .map(r => [score(r), r]).sort((a, b) => a[0] - b[0] || (b[1]._sold || 0) - (a[1]._sold || 0)).map(x => x[1]);
};
function suggestHtml() {
  const q = $("q")?.value || "", list = matches(q);
  if (!list.length) return `<div class="dd-empty">No products match “${esc(q.trim())}”.</div>`;
  return list.slice(0, 8).map(r => `<button type="button" class="dd-item sug" data-pick="${esc(r.sku)}" role="menuitem">
      ${r._tier && r._tier !== "none" ? `<span class="dot" style="--c:var(${tierVar(r._tier)})" title="${esc(r._tier)}"></span>` : `<span class="dot" style="--c:transparent"></span>`}
      <span class="nm"><b>${esc(r.sku)}</b> ${esc(r.name)}</span><span class="mt">${fmtInt(r._qoh)} on hand</span></button>`).join("")
    + `<div class="dd-foot"><span class="muted">${fmtInt(list.length)} match${list.length === 1 ? "" : "es"} · the view below shows them all</span></div>`;
}
function openSuggest() {
  const q = $("q"); if (!q) return;
  if (!q.value.trim()) return ui.menu.isOpen("q") && ui.menu.close();
  if (ui.menu.isOpen("q")) return ui.menu.refresh();
  ui.menu.open(q, { keepFocus: true, html: suggestHtml, onPick: sku => {
    const r = all.find(x => String(x.sku) === sku); if (!r) return;
    q.value = sku; query = sku; apply(); showDetail(r);
  } });
}
function mountSearch() {
  $("topSearch").innerHTML = `<input type="search" class="search" id="q" placeholder="Search SKU, name or UPC" aria-label="Search products" autocomplete="off" aria-haspopup="menu" style="width:100%">`;
  const q = $("q");
  let timer; q.addEventListener("input", e => { openSuggest(); clearTimeout(timer); timer = setTimeout(() => { query = e.target.value; apply(); }, 150); });
  q.addEventListener("focus", () => { if (q.value.trim()) openSuggest(); });
  q.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" && ui.menu.isOpen("q")) { e.preventDefault(); document.querySelector(".dd-menu [data-pick]")?.focus(); }
    if (e.key === "Enter") { clearTimeout(timer); query = q.value; apply(); ui.menu.close(); }
  });
}
// Banner at the top of a view while the search is on: what was searched and how many products it found.
const searchBanner = () => !query.trim() ? "" : `<div class="searchnote" role="status">${shell.ICON.master}<span>Showing results for <b>“${esc(query.trim())}”</b> · ${fmtInt(rows.length)} product${rows.length === 1 ? "" : "s"}</span><button type="button" class="subtle" id="clearSearch">Clear search</button></div>`;

// Reset: back to every product on every platform, with the search box emptied.
function resetFilters() {
  ST.plat = ST.cat = ST.tier = ST.masterFilter = ""; ST.groupPick = null;
  query = ""; if ($("q")) $("q").value = "";
  apply();
}

// ---------- formatting ----------
const platName = ch => CHANNELS[ch] || "All platforms";
const prodCell = r => `<b>${esc(r.sku)}</b><span>${esc(r.name)}</span>`;
// Tier → its color token in ads.css ("reg" shares green; unknown tiers get orange).
const tierVar = t => ({ super: "--tier-super", hero: "--tier-hero", green: "--tier-green", reg: "--tier-green", new: "--tier-new", dead: "--tier-dead",
  empty: "--tier-empty", breathing: "--tier-breathing" })[t] || "--tier-other";
// Tier of a table row: product rows carry _tier, competitor rows wrap the product as .r.
const rowTier = r => { const t = r?._tier ?? r?.r?._tier; return t && t !== "none" ? t : null; };
const tierTag = r => r._tier === "none" ? "<span class=muted>—</span>"
  : `<span class="tier" style="--c:var(${tierVar(r._tier)})">${esc(r._tier)}</span>`;
const daysPill = v => { if (v == null) return "<span class=muted>no sales</span>";
  const c = v <= 0 ? "bad" : v <= SET.trigger ? "bad" : v <= SET.mult ? "warn" : v < 180 ? "good" : "muted";
  return v <= 0 ? `<span class="pill bad">out</span>` : `<span class="pill n ${c}">${Math.round(v)}d</span>`; };
const money = v => v == null ? "<span class=muted>—</span>" : `<span class="${v > 0.005 ? "good" : v < -0.005 ? "bad" : ""}">${fmtUsd(v)}</span>`;
const pctPill = v => v == null ? "<span class=muted>—</span>"
  : `<span class="pill n ${v < 0 ? "bad" : v * 100 < SET.minMargin ? "warn" : "good"}">${fmtPct(v)}</span>`;
const FMT = { int: fmtInt, usd: v => v == null ? "—" : fmtUsd(v), pct: fmtPct, "1": fmt1, text: v => esc(v ?? "—") };
const casesFmt = v => v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
// Demand for the selected platform (or all): units per day.
const dayFor = r => ST.plat ? (r._ch[ST.plat] || 0) / 60 : r._day;
const soldFor = r => ST.plat ? r._ch[ST.plat] || 0 : r._sold;
const soldLabel = () => ST.plat ? `${platName(ST.plat)} 60 days` : `Sold (${SET.window}-day window)`;

// ---------- dynamic table ----------
// table(id, cols, list, opts) returns the HTML of a sortable table.
//   col:  { h: header, v: row → value (sorting, totals, CSV), f: row → html (optional), t: "int" | "usd" | "pct" | "1" | "text",
//           l: left-aligned, prod: product cell, total: add a total in the footer, grp: column group header, tip: header tooltip,
//           key: a stable name when the header text changes (column picker, tile sorts) }
//   opts: { sort: column index, asc, onRow: row click handler, main: CSV file name (marks the view's main table),
//           size: rows per page to start with (10 for the small side tables, 50 otherwise),
//           hide: Set of hidden column keys, empty: message when there are no rows }
// Every table is paged, so no row is ever cut off; totals always cover every row. Each card holding a table also
// gets an expand button (decorateTables) that opens it in a large view.
const PAGE = {};   // table id → { page, size }
function table(id, cols, list, opts = {}) {
  const s = SORT[id] || (SORT[id] = { i: opts.sort ?? -1, asc: !!opts.asc });
  if (s.i >= 0 && cols[s.i]) {
    const v = cols[s.i].v;
    list = [...list].sort((a, b) => cmp(v(a), v(b), s.asc));
  }
  TABLES[id] = { cols, list, onRow: opts.onRow };
  // Hidden columns keep their index so sorting (data-i) and SORT state still line up.
  const vis = cols.map((c, i) => ({ c, i })).filter(x => !opts.hide?.has(colKey(x.c)));
  if (opts.main) lastTable = { name: opts.main, cols: vis.map(x => x.c), list };
  if (!list.length) return `<div class="empty">${opts.empty || "Nothing matches the filters."}</div>`;
  // Which rows to draw: the first opts.limit, or the current page.
  const pg = PAGE[id] || (PAGE[id] = { page: 1, size: opts.size || 50 }), pages = Math.max(1, Math.ceil(list.length / pg.size));
  pg.page = Math.min(Math.max(1, pg.page), pages);
  const start = (pg.page - 1) * pg.size, shown = list.slice(start, start + pg.size);
  const sizes = [...new Set([opts.size || 25, 25, 50, 100, 250])].sort((a, b) => a - b);
  const grp = cols.some(c => c.grp) ? `<tr class="grp">${groupHeads(vis.map(x => x.c))}</tr>` : "";
  const head = vis.map(({ c, i }) => `<th data-t="${id}" data-i="${i}" class="${c.l ? "l" : ""}${s.i === i ? " sorted" + (s.asc ? " asc" : "") : ""}" title="${esc(c.tip || "Sort")}" aria-sort="${s.i === i ? (s.asc ? "ascending" : "descending") : "none"}">${c.h}</th>`).join("");
  const body = shown.map((r, k) => { const t = rowTier(r);
    return `<tr class="${opts.onRow ? "click" : ""}" data-t="${id}" data-r="${start + k}"${t ? ` data-tier style="--rowc:var(${tierVar(t)})"` : ""}>${vis.map(({ c }) => {
    const html = c.f ? c.f(r) : (FMT[c.t || "int"])(c.v(r));
    return `<td class="${c.prod ? "prod" : c.l ? "l" : ""}">${html}</td>`; }).join("")}</tr>`; }).join("");
  const foot = cols.some(c => c.total) ? `<tfoot><tr>${vis.map(({ c }, j) => `<td class="${c.l || c.prod ? "l" : ""}">${
    c.total ? (FMT[c.t || "int"])(sum(list, c.v)) : j === 0 ? `Total · ${list.length.toLocaleString()} rows` : ""}</td>`).join("")}</tr></tfoot>` : "";
  return `<div class="tablewrap" data-scroll="${id}"><table><thead>${grp}<tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>${ui.pager(id, pg.page, pages, list.length, pg.size, sizes)}`;
}
// Column picker for wide tables: a "Columns" dropdown with a checkbox per column, grouped like the table header.
// Hidden column keys are saved per table in this browser.
const colKey = c => c.key || c.h;
const HIDDEN = (() => { try { const h = JSON.parse(localStorage.getItem("asi-v4-hidden") || "{}"); if (h.sheet && !h.master) h.master = h.sheet; delete h.sheet; return h; } catch { return {}; } })();
const saveHidden = () => { try { localStorage.setItem("asi-v4-hidden", JSON.stringify(HIDDEN)); } catch {} };
const hiddenSet = id => new Set(HIDDEN[id] || []);
const PICK = {};   // table id → { cols, keep } of the picker last drawn for it (keep: columns that can't be hidden)
function columnPicker(id, cols, keep = []) {
  PICK[id] = { cols, keep };
  const hide = hiddenSet(id), shown = cols.filter(c => !hide.has(colKey(c))).length;
  return `<button type="button" class="dd-trigger" id="cols-${id}" data-cols="${id}" aria-haspopup="menu" aria-expanded="false">${shell.ICON.master}<span class="val">Columns</span><span class="lbl">${shown}/${cols.length}</span></button>`;
}
function openColumnPicker(id) {
  ui.menu.open($("cols-" + id), {
    html: () => {
      const { cols, keep } = PICK[id], hide = hiddenSet(id), groups = [];
      for (const c of cols) { if (keep.includes(colKey(c))) continue; const g = c.grp || "Product"; let x = groups.find(y => y.g === g); if (!x) groups.push(x = { g, cols: [] }); x.cols.push(c); }
      const box = on => `<input type="checkbox" tabindex="-1" ${on ? "checked" : ""}>`;
      return groups.map(x => `<h4>${esc(x.g)}</h4>${x.cols.map(c => `<button type="button" class="dd-item" data-pick="col:${esc(colKey(c))}" role="menuitemcheckbox" aria-checked="${!hide.has(colKey(c))}">${box(!hide.has(colKey(c)))}<span class="nm">${esc(String(c.h).replace(/<[^>]+>/g, ""))}</span></button>`).join("")}`).join("")
        + `<div class="dd-foot"><button type="button" data-pick="all">Show all</button><button type="button" class="subtle" data-pick="none">Hide all</button></div>`;
    },
    onPick: v => {
      const { cols, keep } = PICK[id], hide = hiddenSet(id);
      if (v === "all") hide.clear();
      else if (v === "none") cols.forEach(c => !keep.includes(colKey(c)) && hide.add(colKey(c)));
      else { const k = v.slice(4); hide.has(k) ? hide.delete(k) : hide.add(k); }
      HIDDEN[id] = [...hide]; saveHidden(); render();
      return true;   // keep the menu open while ticking columns
    },
  });
}
function groupHeads(cols) {
  const out = []; let cur = null, n = 0;
  for (const c of cols) { const g = c.grp || ""; if (g === cur) n++; else { if (cur !== null) out.push([cur, n]); cur = g; n = 1; } }
  out.push([cur, n]);
  return out.map(([g, n]) => `<th colspan="${n}">${esc(g)}</th>`).join("");
}
// Sort compare: empty values always last, text alphabetically, numbers by size.
function cmp(x, y, asc) {
  const xn = x == null || x === "", yn = y == null || y === "";
  if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
  const d = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y;
  return asc ? d : -d;
}
const PROD = { h: "Product", v: r => r.name, f: prodCell, prod: true, l: true };
const TIER = { h: "Tier", v: r => r._tier, f: tierTag, l: true };

// ---------- layout ----------
const TABS = shell.VIEWS;
const VIEW_HTML = () => ({ overview: overviewHtml, sold: soldHtml, reorder: reorderHtml, pl: plHtml, master: masterHtml, vendors: vendorsHtml,
  competitors: competitorsHtml, insights: insightsHtml });
// Only Reorder plans ahead for a chosen number of days; the other views show the API's fixed counts and project 30 days.
const H = () => ST.tab === "reorder" ? ST.horizon : 30;
// Draw the current view. Called after every change; it keeps scroll positions so a redraw doesn't jump.
function render() {
  saveState();
  const scrolls = {}, pageY = window.scrollY;
  document.querySelectorAll(".tablewrap[data-scroll]").forEach(el => { scrolls[el.dataset.scroll] = [el.scrollTop, el.scrollLeft]; });
  shell.setActive(ST.tab);
  $("title").textContent = TABS[ST.tab];
  document.title = `${TABS[ST.tab]} · Fragrance Wholesaler USA`;
  if (location.hash.slice(1) !== ST.tab) history.replaceState(null, "", "#" + ST.tab);
  renderFilters(); renderFoot();
  Object.values(charts).forEach(c => c.destroy()); charts = {};
  lastTable = null;
  $("main").innerHTML = searchBanner() + VIEW_HTML()[ST.tab]();
  if (ST.tab === "overview" || ST.tab === "sold") drawPlatformChart("chPlat", "units");
  if (ST.tab === "pl" && !ST.plat) drawPlatformChart("chPlProfit", "profit");
  $("csv").hidden = !lastTable;
  decorateTables();
  document.querySelectorAll(".tablewrap[data-scroll]").forEach(el => { const s = scrolls[el.dataset.scroll]; if (s) [el.scrollTop, el.scrollLeft] = s; });
  window.scrollTo(window.scrollX, pageY);
  ui.menu.refresh();
}
// ---------- large table view ----------
// Each card that holds a table gets an expand button at its top right. Expanding pins the card over the page
// (with a dimmed backdrop) so the table gets the whole screen; sorting and paging keep working inside it.
let EXPANDED = null;   // table id of the card shown large, kept across redraws
const EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
const SHRINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/></svg>';
function decorateTables() {
  let found = false;
  document.querySelectorAll("#main section.card").forEach(card => {
    const w = card.querySelector(".tablewrap[data-scroll]"); if (!w) return;
    const id = w.dataset.scroll, big = EXPANDED === id; found ||= big;
    card.classList.add("has-expand"); card.classList.toggle("expanded", big);
    card.insertAdjacentHTML("afterbegin", `<button type="button" class="subtle expand" data-expand="${id}" title="${big ? "Close the large view (Esc)" : "Open in a large view"}" aria-label="${big ? "Close large view" : "Open large view"}">${big ? SHRINK_ICON : EXPAND_ICON}</button>`);
  });
  if (!found) EXPANDED = null;
  document.body.classList.toggle("has-expanded", !!EXPANDED);
}
// Small side tables page 10 rows at a time; the large view shows at least 50 and goes back when closed.
let smallSize = null;
function toggleExpand(id) {
  const opening = EXPANDED !== id, pg = PAGE[id];
  if (EXPANDED && EXPANDED !== id && smallSize) { PAGE[EXPANDED].size = smallSize; smallSize = null; }
  EXPANDED = opening ? id : null;
  if (opening && pg && pg.size < 50) { smallSize = pg.size; pg.size = 50; pg.page = 1; return render(); }
  if (!opening && smallSize && pg) { pg.size = smallSize; pg.page = 1; smallSize = null; return render(); }
  decorateTablesOnly();
}
// Re-mark the cards without redrawing the view (the buttons are replaced, the tables stay as they are).
function decorateTablesOnly() { document.querySelectorAll("#main .card > .expand").forEach(b => b.remove()); decorateTables(); }
document.addEventListener("keydown", e => { if (e.key === "Escape" && EXPANDED && !document.querySelector("dialog[open]") && !document.querySelector(".dd-menu:not([hidden])")) toggleExpand(EXPANDED); });

// Switch view (side nav link or code), resetting the per-view drill-downs.
function goTab(tab) {
  tab = shell.OLD_VIEWS[tab] || tab;
  if (!(tab in TABS)) return;
  ST.tab = tab; ST.groupPick = null; ST.vendor = ""; ST.masterFilter = ""; EXPANDED = null;
  if (all.length) render();
  window.scrollTo(0, 0);
}

// ---------- Overview ----------
// Overview tiles and Product master share these, so a tile's count matches the rows it opens.
// sort: the Product master column key to sort by. allPlats: the tile ignores the platform filter.
const TILE_FILTERS = {
  top: { label: () => "Selling products, by projected sales", test: r => dayFor(r) > 0, sort: ["Next", false] },
  reorder: { label: () => "Reorder now", test: r => r._trigger, sort: ["Order cost", false] },
  runout: { label: () => `Runs out within ${H()} days`, test: r => r._days != null && r._days > 0 && r._days <= H(), sort: ["Days of stock", true] },
  out: { label: () => "Out of stock, still selling", test: r => r._qoh <= 0 && r._sold > 0, sort: ["Sold", false] },
  stock: { label: () => "All products, by stock value", test: () => true, sort: ["Stock value", false], allPlats: true },
};
const onPlat = r => !ST.plat || r._ch[ST.plat] > 0;
function overviewHtml() {
  const h = H(), sel = ST.plat ? rows.filter(r => r._ch[ST.plat] > 0) : rows;
  const proj = sum(sel, r => dayFor(r) * h);
  const order = rows.filter(r => TILE_FILTERS.reorder.test(r) && onPlat(r));
  const out = rows.filter(r => TILE_FILTERS.out.test(r) && onPlat(r));
  const runOut = rows.filter(r => TILE_FILTERS.runout.test(r) && onPlat(r));
  const tile = (go, label, value, sub, alert) => `<button class="kpi ${alert ? "alert" : ""}" data-go="${go}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></button>`;
  const top = [...sel].filter(r => dayFor(r) > 0).sort((a, b) => dayFor(b) - dayFor(a));
  return `<p class="lead">${ST.plat ? `<b>${platName(ST.plat)}</b>: what` : "What"} will sell in the next <b>${h} days</b> and what to reorder. Projections use each product's day average${ST.plat ? " on this platform (60-day units ÷ 60)" : ` (sold in the window ÷ ${SET.window}, like the sheet's DAY AVE)`}.</p>
  <section class="kpis">
    ${tile("top", `Projected sales, next ${h} days`, fmtInt(proj), `${fmt1(proj / h)} units/day · ${fmtInt(sel.filter(r => dayFor(r) > 0).length)} SKUs selling`)}
    ${tile("reorder", "Reorder now", fmtInt(order.length), `${fmtInt(sum(order, r => r._cases))} cases · ${fmtUsd(sum(order, r => r._orderCost))}`, order.length)}
    ${tile("runout", `Runs out within ${h} days`, fmtInt(runOut.length), "still has stock today")}
    ${tile("out", "Out of stock, still selling", fmtInt(out.length), "0 on hand, sold in the window", out.length)}
    ${tile("stock", "Stock value", fmtUsd(sum(rows, r => r._value)), `${fmtInt(sum(rows, r => Math.max(0, r._qoh)))} units on hand`)}
  </section>
  <div class="grid">
    <section class="card"><h3>Units sold by platform, last 60 days</h3><p class="hint">Click a bar to filter every view to that platform.</p><div class="chart"><canvas id="chPlat"></canvas></div></section>
    <section class="card"><h3>Running out first</h3><p class="hint">Selling products with the fewest days of stock left. Red means at or under the ${SET.trigger}-day trigger.</p>
      ${table("soon", [PROD, { h: "Live inv", v: r => r._qoh }, { h: "Day ave", v: dayFor, t: "1" }, { h: "Days of stock", v: r => r._days, f: r => daysPill(r._days) }, { h: "Order qty", v: r => r._orderQty }],
        rows.filter(r => r._days != null && (!ST.plat || r._ch[ST.plat] > 0)), { sort: 3, asc: true, size: 10, onRow: showDetail })}</section>
  </div>
  <section class="card" id="topCard"><div class="head"><div><h3>Top sellers, projected next ${h} days</h3><p class="hint" style="margin:0">Sorted by projected units. Click a row for the full breakdown.</p></div></div>
    ${table("top", [PROD, TIER, { h: "Live inv", v: r => r._qoh },
      { h: soldLabel(), v: soldFor },
      { h: "Day ave", v: dayFor, t: "1" },
      ...PERIODS.map(n => ({ h: `Next ${n}d`, v: r => dayFor(r) * n, tip: `Day ave × ${n}` })),
      { h: "Days of stock", v: r => r._days, f: r => daysPill(r._days) },
      { h: `Short in ${h}d`, v: r => Math.max(0, dayFor(r) * h - r._qoh - r._inProg), f: r => { const v = Math.max(0, dayFor(r) * h - r._qoh - r._inProg); return v ? `<span class=bad>${fmtInt(v)}</span>` : "<span class=muted>0</span>"; }, tip: "Projected units minus live inventory and on order" }],
      top, { sort: 5 + PERIODS.indexOf(h), onRow: showDetail, main: "top-sellers" })}</section>`;
}

function drawPlatformChart(id, mode) {
  const el = $(id); if (!el || typeof Chart === "undefined") return;
  const list = mode === "units"
    ? Object.keys(CHANNELS).map(k => ({ k, label: CHANNELS[k], v: sum(rows, r => r._ch[k]) }))
    : PL.map(x => ({ k: x.ch, label: x.label, v: sum(rows, r => r._pl[x.k].profit60 ?? 0) }));
  list.sort((a, b) => b.v - a.v);
  const accent = css("--ds-chart-brand"), muted = css("--ds-text-subtlest"), border = css("--ds-border");
  Chart.defaults.font.family = css("--ds-font");
  charts[id] = new Chart(el, {
    type: "bar",
    data: { labels: list.map(x => x.label), datasets: [{ data: list.map(x => x.v),
      backgroundColor: list.map(x => x.k === ST.plat ? css("--ds-chart-warning") : x.v < 0 ? css("--ds-chart-danger") : accent) }] },
    options: { indexAxis: "y", maintainAspectRatio: false, animation: false, plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => mode === "units" ? `${fmtInt(c.raw)} units` : fmtUsd(c.raw) } } },
      scales: { x: { ticks: { color: muted, callback: v => mode === "units" ? fmtInt(v) : fmtUsd(v) }, grid: { color: border } }, y: { ticks: { color: muted }, grid: { display: false } } },
      onClick: (e, els) => { if (!els.length) return; const k = list[els[0].index].k; setTimeout(() => { ST.plat = ST.plat === k ? "" : k; render(); }); } },
  });
}
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- Items sold ----------
// Exact units from the products API: each platform's last 60 days. No estimates on this view.
function soldHtml() {
  const p = ST.plat, units = r => p ? r._ch[p] || 0 : r._ch60;
  const list = ST.soldShow === "all" ? rows : rows.filter(r => units(r) > 0);
  const sold = rows.filter(r => units(r) > 0), total = sum(rows, units);
  const chList = Object.keys(CHANNELS).map(k => ({ k, u: sum(rows, r => r._ch[k]) })).sort((a, b) => b.u - a.u);
  const best = [...sold].sort((a, b) => units(b) - units(a))[0];
  const cats = new Map();
  for (const r of sold) { const c = r.category || "No category"; const x = cats.get(c) || { name: c, skus: 0, units: 0 }; x.skus++; x.units += units(r); cats.set(c, x); }
  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const cols = [
    { ...PROD, grp: "" }, { ...TIER, grp: "" }, { h: "Category", v: r => r.category, t: "text", l: true, grp: "" },
    { h: "Live inv", v: r => r._qoh, grp: "" },
    ...Object.keys(CHANNELS).map(k => ({ h: CHANNELS[k], v: r => r._ch[k], f: r => r._ch[k] ? (k === p ? `<b>${fmtInt(r._ch[k])}</b>` : fmtInt(r._ch[k])) : "<span class=muted>0</span>", grp: "Last 60 days by platform", total: true })),
    { h: "Total 60 days", v: r => r._ch60, f: r => `<b>${fmtInt(r._ch60)}</b>`, grp: "Last 60 days by platform", total: true },
    { h: "Per day", v: r => units(r) / 60, t: "1", grp: "", tip: "Units in the last 60 days ÷ 60" + (p ? `, on ${platName(p)}` : "") },
  ];
  const sortKey = p ? CHANNELS[p] : "Total 60 days", hide = hiddenSet("sold");
  // Columns stay in a fixed order so a sort survives filter changes; picking a platform sorts by it.
  if (!SORT.sold || SORT.sold.plat !== p) SORT.sold = { i: cols.findIndex(c => colKey(c) === sortKey), asc: false, plat: p };
  return `<p class="lead">How many of each product sold in the <b>last 60 days</b>${p ? ` on <b>${platName(p)}</b>` : ", per platform"}. These are the exact counts from the products API, which has no shorter period per platform.</p>
  <section class="kpis">
    ${kpi(`Units sold, 60 days${p ? ` · ${platName(p)}` : ""}`, fmtInt(total), `${fmt1(total / 60)} a day on average`)}
    ${kpi("Products sold", fmtInt(sold.length), `of ${fmtInt(rows.length)} in the filters`)}
    ${p ? kpi("Share of all sales", sum(rows, r => r._ch60) ? fmtPct(total / sum(rows, r => r._ch60)) : "—", `${platName(p)} vs every platform`)
        : kpi("Top platform", chList[0]?.u ? CHANNELS[chList[0].k] : "—", chList[0]?.u ? `${fmtInt(chList[0].u)} units · ${fmtPct(chList[0].u / (total || 1))}` : "no sales")}
    ${kpi("Best seller", best ? esc(best.sku) : "—", best ? `${fmtInt(units(best))} units · ${esc(String(best.name || "").slice(0, 40))}` : "no sales")}
  </section>
  <div class="grid">
    <section class="card"><h3>Units by platform, last 60 days</h3><p class="hint">Click a bar to filter every view to that platform.</p><div class="chart"><canvas id="chPlat"></canvas></div></section>
    <section class="card"><h3>By category</h3><p class="hint">Units sold in the last 60 days${p ? ` on ${platName(p)}` : ""}.</p>
      ${table("soldcat", [{ h: "Category", v: x => x.name, l: true, f: x => `<b>${esc(x.name)}</b>` }, { h: "Products sold", v: x => x.skus, total: true },
        { h: "Units", v: x => x.units, total: true }, { h: "Share", v: x => total ? x.units / total : null, t: "pct" }], [...cats.values()],
        { sort: 2, onRow: x => { ST.cat = x.name === "No category" ? "" : x.name; apply(); }, size: 10, empty: "No sales in the last 60 days." })}</section>
  </div>
  <section class="card"><div class="head"><div><h3>Products</h3><p class="hint">Click a column to sort, a row for the full breakdown.</p></div>
    <div class="row">${columnPicker("sold", cols, ["Product"])}<div class="seg">${[["sold", `Sold (${fmtInt(sold.length)})`], ["all", `All products (${fmtInt(rows.length)})`]].map(([k, v]) => `<button data-ss="${k}" class="${ST.soldShow === k ? "active" : ""}">${v}</button>`).join("")}</div></div></div>
    ${table("sold", cols, list, { onRow: showDetail, main: "items-sold", hide, empty: "Nothing sold in the last 60 days with these filters." })}</section>`;
}

// ---------- Reorder ----------
const GROUPS = {
  vendor: ["Supplier (current vendor)", r => r._vendor],
  cheapest: ["Cheapest vendor quote", r => r._bestVendor ? VENDORS[r._bestVendor] : "No vendor quote"],
  platform: ["Top platform", r => r._topCh ? CHANNELS[r._topCh] : "No platform sales"],
  tier: ["Tier", r => r._tier],
  none: ["No grouping", () => ""],
};
function reorderList() {
  let list = rows;
  if (ST.plat) list = list.filter(r => r._ch[ST.plat] > 0);
  if (ST.show === "order") list = list.filter(r => r._trigger && r._orderQty > 0);
  else if (ST.show === "selling") list = list.filter(r => r._sold > 0);
  return list;
}
function reorderHtml() {
  const list = reorderList(), h = H(), g = GROUPS[ST.group];
  const order = list.filter(r => r._trigger);
  const controls = `<div class="row">
      ${ui.selectTrigger("groupBy", "Group by", esc(g[0]), false)}
      <label class="t">Show</label><div class="seg" id="showSeg">${[["order", "Needs order"], ["selling", "All selling"], ["all", "Everything"]].map(([k, v]) => `<button data-show="${k}" class="${ST.show === k ? "active" : ""}">${v}</button>`).join("")}</div>
    </div>`;
  const period = `<div class="row" style="margin-bottom:12px"><label class="t">Plan for the next</label><div class="seg">${PERIODS.map(n => `<button data-h="${n}" class="${ST.horizon === n ? "active" : ""}">${n} days</button>`).join("")}</div></div>`;
  const lead = period + `<p class="lead">Same math as the sheet: <b>DAY AVE</b> = sold ÷ ${SET.window}, reorder when <b>days of stock ≤ ${SET.trigger}</b>, order <b>DAY AVE × ${SET.mult} − live inv − on order</b>, rounded up to whole cases, costed at platform cost. ${settingsHtml()}</p>`;
  const kpis = `<section class="kpis">
    <div class="kpi"><div class="label">SKUs to reorder</div><div class="value">${fmtInt(order.length)}</div><div class="sub">at or under ${SET.trigger} days of stock</div></div>
    <div class="kpi"><div class="label">Order quantity</div><div class="value">${fmtInt(sum(order, r => r._orderQty))}</div><div class="sub">${fmtInt(sum(order, r => r._cases))} cases</div></div>
    <div class="kpi"><div class="label">Order cost</div><div class="value">${fmtUsd(sum(order, r => r._orderCost))}</div><div class="sub">order qty × platform cost</div></div>
    <div class="kpi"><div class="label">Projected sales, next ${h} days</div><div class="value">${fmtInt(sum(list, r => dayFor(r) * h))}</div><div class="sub">for the products listed</div></div>
  </section>`;
  let body;
  if (ST.group !== "none" && !ST.groupPick) {
    const groups = new Map();
    for (const r of list) { const k = g[1](r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const gl = [...groups].map(([name, items]) => ({ name, items }));
    body = `<section class="card"><div class="head"><h3>By ${g[0].toLowerCase()}</h3>${controls}</div>
      <p class="hint">Click a row to see its products.</p>
      ${table("rgroups", [
        { h: g[0], v: x => x.name, l: true, f: x => `<b>${esc(x.name)}</b>` },
        { h: "SKUs", v: x => x.items.length, total: true },
        { h: "To reorder", v: x => x.items.filter(r => r._trigger).length, total: true },
        { h: soldLabel(), v: x => sum(x.items, soldFor), total: true },
        { h: "Day ave", v: x => sum(x.items, dayFor), t: "1", total: true },
        { h: `Next ${h}d`, v: x => sum(x.items, r => dayFor(r) * h), total: true },
        { h: "Live inv", v: x => sum(x.items, r => Math.max(0, r._qoh)), total: true },
        { h: "On order", v: x => sum(x.items, r => r._inProg), total: true },
        { h: "Cases", v: x => sum(x.items, r => r._cases), total: true },
        { h: "Order qty", v: x => sum(x.items, r => r._orderQty), total: true },
        { h: "Order cost", v: x => sum(x.items, r => r._orderCost), t: "usd", total: true },
      ], gl, { sort: 10, onRow: x => { ST.groupPick = x.name; render(); }, main: "reorder-groups" })}</section>`;
  } else {
    const items = ST.groupPick != null ? list.filter(r => g[1](r) === ST.groupPick) : list;
    const chip = ST.groupPick != null ? `<span class="chip">${esc(g[0])}: ${esc(ST.groupPick)}<button id="ungroup" title="Back to groups">×</button></span>` : "";
    body = `<section class="card"><div class="head"><div class="row"><h3>Products</h3>${chip}</div>${controls}</div>
      ${table("rskus", reorderCols(), items, { sort: 15, onRow: showDetail, main: "reorder", empty: "Nothing to reorder here." })}</section>`;
  }
  return lead + kpis + body;
}
function reorderCols() {
  const h = H();
  return [
    { ...PROD, grp: "" }, { ...TIER, grp: "" }, { h: "Supplier", v: r => r._vendor, t: "text", l: true, grp: "" },
    { h: "Live inv", v: r => r._qoh, grp: "Inventory", total: true },
    { h: "Case qty", v: r => r._caseQty, grp: "Inventory" },
    { h: "Cases hand", v: r => r._casesHand, f: r => casesFmt(r._casesHand), grp: "Inventory" },
    { h: "On order", v: r => r._inProg, grp: "Inventory", total: true },
    { h: soldLabel(), v: soldFor, grp: "Sales", total: true },
    { h: "Day ave", v: dayFor, t: "1", grp: "Sales" },
    { h: "Monthly", v: r => r._monthly, grp: "Sales", tip: "DAY AVE × 30" },
    { h: `Next ${h}d`, v: r => dayFor(r) * h, grp: "Sales", total: true },
    { h: "Days of stock", v: r => r._days, f: r => daysPill(r._days), grp: "Reorder" },
    { h: "Reorder point", v: r => r._rop, grp: "Reorder", tip: `DAY AVE × ${SET.trigger}` },
    { h: "Need for month", v: r => r._needMonth, f: r => r._needMonth > 0 ? `<span class=warn>${fmtInt(r._needMonth)}</span>` : `<span class=muted>${fmtInt(r._needMonth)}</span>`, grp: "Reorder" },
    { h: "Cases", v: r => r._cases, grp: "Reorder", total: true },
    { h: "Order qty", v: r => r._orderQty, f: r => r._orderQty ? `<b>${fmtInt(r._orderQty)}</b>` : "<span class=muted>0</span>", grp: "Reorder", total: true },
    { h: "Order cost", v: r => r._orderCost, t: "usd", grp: "Reorder", total: true },
    { h: "Platform cost", v: r => r._AN, t: "usd", grp: "Cost" },
    { h: "Cheapest quote", v: r => r._best, f: r => r._best == null ? "<span class=muted>—</span>" : `${fmtUsd(r._best)} <span class=muted>${esc(VENDORS[r._bestVendor])}</span>`, grp: "Cost" },
  ];
}
function settingsHtml() {
  return `<details class="settings" ${settingsOpen ? "open" : ""}><summary>Change the sheet's numbers</summary><div class="row">
    <label>Sales window days <input type="number" data-set="window" value="${SET.window}" min="1"></label>
    <label>Order multiplier (days) <input type="number" data-set="mult" value="${SET.mult}" min="1"></label>
    <label>Trigger (days of stock) <input type="number" data-set="trigger" value="${SET.trigger}" min="1"></label>
    <label>Min profit % <input type="number" data-set="minMargin" value="${SET.minMargin}" min="0"></label>
    <button id="resetSet">Reset to sheet</button></div></details>`;
}

// ---------- Profit & Loss ----------
function plHtml() {
  const lead = `<p class="lead">Per-platform profit using the sheet's formulas: cost <b>Q = total cost to ship</b> (platform cost + box + $${SET.misc.toFixed(2)}), each platform's fee and shipping rule, and <b>PFT% = profit ÷ (cost + profit)</b>. TikTok uses its real price; other platforms use the sheet's price formula${SET.livePrices ? ", or the live listing price when the API has one" : ""}. Per-SKU price adjustments in the sheet are not in the API.
    <label style="margin-left:8px"><input type="checkbox" id="livePrices" ${SET.livePrices ? "checked" : ""}> Use live listing prices where available</label></p>`;
  if (!ST.plat || !PL_BY_CH[ST.plat]) {
    const sum1 = PL.map(x => {
      const priced = rows.filter(r => r._pl[x.k].price != null), sold = priced.filter(r => r._pl[x.k].units > 0);
      return { x, priced, units: sum(priced, r => r._pl[x.k].units), profit60: sum(priced, r => r._pl[x.k].profit60),
        rev60: sum(priced, r => r._pl[x.k].price * r._pl[x.k].units),
        avgProfit: priced.length ? sum(priced, r => r._pl[x.k].profit) / priced.length : null,
        avgPct: sold.length ? sum(sold, r => r._pl[x.k].profit60) / sum(sold, r => (r._pl[x.k].profit + r._Q) * r._pl[x.k].units) : null,
        low: priced.filter(r => r._pl[x.k].pct * 100 < SET.minMargin).length, losing: priced.filter(r => r._pl[x.k].profit < 0).length };
    });
    const extra = ST.plat ? `<p class="hint">${platName(ST.plat)} has no profit formula in the sheet, so it is not in this table.</p>` : "";
    return lead + extra + `<section class="card"><h3>Platform summary</h3><p class="hint">Like the sheet's PRICE / PFT / % / 60 DAYS blocks, totalled across products. Click a platform for its products.</p>
      ${table("plsum", [
        { h: "Platform", v: s => s.x.label, l: true, f: s => `<b>${s.x.label}</b>` },
        { h: "Fee rule · price formula", v: s => s.x.rule, l: true, f: s => `${esc(s.x.rule)}<br><span class=muted style="font-size:12px">${esc(s.x.formula)}</span>` },
        { h: "Priced SKUs", v: s => s.priced.length },
        { h: "Avg profit / unit", v: s => s.avgProfit, f: s => money(s.avgProfit) },
        { h: "PFT% (60-day weighted)", v: s => s.avgPct, f: s => pctPill(s.avgPct) },
        { h: "60-day units", v: s => s.units, total: true },
        { h: "60-day revenue", v: s => s.rev60, t: "usd", total: true },
        { h: "60-day profit", v: s => s.profit60, f: s => money(s.profit60), t: "usd", total: true },
        { h: `Under ${SET.minMargin}%`, v: s => s.low, f: s => s.low ? `<span class=warn>${s.low}</span>` : "0" },
        { h: "Losing money", v: s => s.losing, f: s => s.losing ? `<span class=bad>${s.losing}</span>` : "0" },
      ], sum1, { sort: 7, onRow: s => { ST.plat = s.x.ch; render(); }, main: "pl-platforms" })}</section>
      <section class="card"><h3>60-day profit by platform</h3><p class="hint">Profit per unit × units sold on that platform in 60 days.</p><div class="chart"><canvas id="chPlProfit"></canvas></div></section>`;
  }
  const x = PL_BY_CH[ST.plat];
  let list = rows.filter(r => r._pl[x.k].price != null);
  const counts = { all: list.length, sold: list.filter(r => r._pl[x.k].units > 0).length,
    low: list.filter(r => r._pl[x.k].pct * 100 < SET.minMargin).length, losing: list.filter(r => r._pl[x.k].profit < 0).length };
  if (ST.plFilter === "sold") list = list.filter(r => r._pl[x.k].units > 0);
  if (ST.plFilter === "low") list = list.filter(r => r._pl[x.k].pct * 100 < SET.minMargin);
  if (ST.plFilter === "losing") list = list.filter(r => r._pl[x.k].profit < 0);
  const L = r => r._pl[x.k], missing = rows.length - counts.all;
  return lead + `<section class="card"><div class="head"><div><h3>${x.label} P&L by product</h3>
      <p class="hint" style="margin:0">${x.rule}. Price: ${x.formula}. ${missing ? `${missing} products have no ${x.k === "tiktok" ? "TikTok price" : "cost"} and are left out.` : ""}</p></div>
      <div class="seg" id="plSeg">${[["all", "All"], ["sold", "Sold in 60d"], ["low", `Under ${SET.minMargin}%`], ["losing", "Losing"]].map(([k, v]) => `<button data-pf="${k}" class="${ST.plFilter === k ? "active" : ""}">${v} (${counts[k]})</button>`).join("")}</div></div>
    ${table("plsku", [PROD, TIER,
      { h: "Price", v: r => L(r).price, f: r => `${fmtUsd(L(r).price)}${L(r).src === "Excel formula" ? `<span class="calc" title="Calculated with the sheet's formula">calc</span>` : ""}` },
      { h: "Live listing", v: r => L(r).live, t: "usd" },
      { h: x.base === "AN" ? "Platform cost" : "Cost (Q)", v: r => L(r).base, t: "usd" },
      { h: "Fees", v: r => L(r).fee, t: "usd" },
      { h: "Ship we pay", v: r => L(r).ship, t: "usd" },
      { h: "Profit / unit", v: r => L(r).profit, f: r => money(L(r).profit) },
      { h: "PFT%", v: r => L(r).pct, f: r => pctPill(L(r).pct) },
      { h: "60 days", v: r => L(r).units, total: true },
      { h: "60-day profit", v: r => L(r).profit60, f: r => money(L(r).profit60), t: "usd", total: true },
      { h: "Live inv", v: r => r._qoh },
    ], list, { sort: 10, onRow: showDetail, main: `pl-${x.k}` })}</section>`;
}

// ---------- Product master (the workbook's master tab, column for column) ----------
function masterCols() {
  const h = H();
  return [
    // A few SKUs in the API are long names; cut them so they don't stretch the column.
    { h: "SKU #", v: r => r.sku, f: r => `<span class="clip" style="--w:150px" title="${esc(r.sku)}">${esc(r.sku)}</span>`, l: true, grp: "" },
    { h: "Product name", v: r => r.name, f: r => `<span class="clip" title="${esc(r.name)}">${esc(r.name)}</span>`, l: true, grp: "" },
    { ...TIER, grp: "" },
    { h: "Days of stock", v: r => r._days, f: r => daysPill(r._days), grp: "Inventory" },
    { h: "Live inv", v: r => r._qoh, grp: "Inventory" },
    { h: "Total cost to ship", v: r => r._Q, t: "usd", grp: "Cost" },
    { h: "Ship charge", v: r => r._AG, t: "usd", grp: "Cost" },
    { h: "Box cost", v: r => r._box, t: "usd", grp: "Cost" },
    { h: "Platform cost", v: r => r._AN, t: "usd", grp: "Cost" },
    { h: "Wholesale cost", v: r => r._AS, t: "usd", grp: "Cost" },
    { h: "Current vendor", v: r => r._vendor, t: "text", l: true, grp: "Cost" },
    { h: "Cheapest vendor", v: r => r._best, f: r => r._best == null ? "<span class=muted>—</span>" : `${fmtUsd(r._best)} <span class=muted>${esc(VENDORS[r._bestVendor])}</span>`, grp: "Cost" },
    { h: "Qty in case", v: r => r._caseQty, grp: "Stock statistics" },
    { h: "Cases hand", v: r => r._casesHand, f: r => casesFmt(r._casesHand), grp: "Stock statistics" },
    { h: "Stock value", v: r => r._value, t: "usd", grp: "Stock statistics", total: true },
    { h: `Sold ${SET.window}d`, key: "Sold", v: r => r._sold, grp: "Stock statistics", total: true },
    { h: "Returned", v: r => r._returns, grp: "Stock statistics", total: true },
    { h: "Day ave", v: r => r._day, t: "1", grp: "Stock statistics" },
    { h: "Highest day avg", v: r => r._hiDay, t: "1", grp: "Stock statistics" },
    { h: "Monthly sold", v: r => r._monthly, t: "1", grp: "Stock statistics" },
    { h: `Next ${h}d`, key: "Next", v: r => r._day * h, grp: "Stock statistics" },
    ...Object.entries(CHANNELS).map(([k, v]) => ({ h: v, v: r => r._ch[k], f: r => r._ch[k] ? fmtInt(r._ch[k]) : "<span class=muted>0</span>", grp: "Platform sales (60 days)", total: true })),
    { h: "Sold 60 days", v: r => r._ch60, f: r => `<b>${fmtInt(r._ch60)}</b>`, grp: "Platform sales (60 days)", total: true },
    { h: "Need for month", v: r => r._needMonth, grp: "Ordering" },
    { h: "Trigger", v: r => r._trigger ? 1 : 0, f: r => r._trigger ? `<span class="pill bad">order</span>` : "", grp: "Ordering" },
    { h: "Cases order", v: r => r._cases, grp: "Ordering", total: true },
    { h: "Order qty", v: r => r._orderQty, grp: "Ordering", total: true },
    { h: "Order cost", v: r => r._orderCost, t: "usd", grp: "Ordering", total: true },
  ];
}
function masterHtml() {
  const cols = masterCols(), f = TILE_FILTERS[ST.masterFilter];
  const list = rows.filter(r => (f?.allPlats || onPlat(r)) && (!f || f.test(r)));
  const banner = f ? `<div class="msg"><span>Showing <b>${esc(f.label())}</b>${ST.plat && !f.allPlats ? ` on ${esc(platName(ST.plat))}` : ""} · ${fmtInt(list.length)} of ${fmtInt(rows.length)} products</span>
    <button id="clearMasterFilter">Show all products</button></div>` : "";
  return `<p class="lead">Every product with the workbook's main columns, in the same order, filled from the API. Click a column to sort, a row for details.</p>
    ${banner}<section class="card"><div class="head"><h3>All products</h3>${columnPicker("master", cols, ["SKU #"])}</div>
    ${table("master", cols, list, { sort: 3, asc: true, onRow: showDetail, main: "product-master", hide: hiddenSet("master") })}</section>`;
}

// ---------- Insights ----------
// Two money lists: stock beyond the cover target (cash to free up) and products a vendor quotes cheaper than we pay.
const QUOTE_FRESH_DAYS = 90;
// Lowest TikTok price that doesn't lose money: 20% fee, and we pay shipping at $30 and up (as in PL).
function tiktokFloor(r) {
  if (r._Q == null) return null;
  const noShip = r._Q / 0.8;
  if (noShip < 30) return noShip;
  return Math.max(30, (r._Q + r._AG) / 0.8);
}
function overstockList() {
  const cover = ST.cover;
  return rows.filter(r => r._qoh > 0 && r._AN != null && (!ST.plat || r._ch[ST.plat] > 0)).map(r => {
    const day = dayFor(r), excess = day > 0 ? Math.max(0, r._qoh - day * cover) : r._qoh;
    const days = day > 0 ? r._qoh / day : null;
    const action = day <= 0 ? "Liquidate" : days > 365 ? "Mark down" : "Bundle / promo";
    return { ...r, _xs: excess, _xsValue: excess * r._AN, _xsDays: days, _action: action, _floor: tiktokFloor(r) };
  }).filter(r => r._xs >= 1);
}
function savingsList() {
  return rows.filter(r => r._AN > 0 && r._best != null && r._best < r._AN - 0.005 && dayFor(r) > 0).map(r => {
    const save = r._AN - r._best, q = r._prices[0];
    const age = q.date ? (Date.now() - q.date) / 864e5 : null;
    const fresh = age != null && age <= QUOTE_FRESH_DAYS, suspect = r._best < r._AN * 0.5;
    return { ...r, _save: save, _yearSave: save * dayFor(r) * 365, _orderSave: save * r._orderQty, _qDate: q.date,
      _fresh: fresh, _suspect: suspect,
      _note: suspect ? "Over 50% cheaper: check size" : !q.date ? "Quote has no date" : !fresh ? `Quote over ${QUOTE_FRESH_DAYS} days old` : "" };
  });
}
function insightsHtml() {
  const over = overstockList(), noSale = over.filter(r => dayFor(r) <= 0);
  const stockValue = sum(rows, r => r._value), xsValue = sum(over, r => r._xsValue);
  const allSave = savingsList(), solid = allSave.filter(r => r._fresh && !r._suspect);
  const save = ST.vf === "solid" ? solid : allSave;
  const seg = (attr, cur, opts) => `<div class="seg">${opts.map(([k, v]) => `<button data-${attr}="${k}" class="${String(cur) === String(k) ? "active" : ""}">${v}</button>`).join("")}</div>`;
  const kpi = (label, value, sub, alert) => `<div class="kpi ${alert ? "alert" : ""}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const qDate = r => r._qDate ? `<span class="${r._fresh ? "" : "warn"}">${fmtDate(r._qDate)}</span>` : `<span class=muted>no date</span>`;
  return `<p class="lead">Where the money is${ST.plat ? ` on <b>${platName(ST.plat)}</b>` : ""}: stock you could turn back into cash, and products a vendor sells cheaper than you pay now. Click a row for the full breakdown; <b>Export CSV</b> saves the vendor list.</p>
  <section class="kpis">
    ${kpi("Cash tied up in overstock", fmtUsd(xsValue), `${fmtInt(over.length)} SKUs · ${stockValue ? fmtPct(xsValue / stockValue) : "—"} of stock value`, xsValue)}
    ${kpi("Of that, not selling at all", fmtUsd(sum(noSale, r => r._xsValue)), `${fmtInt(noSale.length)} SKUs with no sales in the window`)}
    ${kpi("Vendor savings, per year", fmtUsd(sum(allSave, r => r._yearSave)), `${fmtInt(allSave.length)} selling SKUs with a cheaper quote`)}
    ${kpi("Savings on recent quotes only", fmtUsd(sum(solid, r => r._yearSave)), `${fmtInt(solid.length)} SKUs · quote within ${QUOTE_FRESH_DAYS} days, under 50% off`)}
  </section>
  <section class="card"><div class="head"><div><h3>Overstock: cash to free up</h3>
    <p class="hint" style="margin:0">Units above ${ST.cover} days of supply at the current day average, valued at platform cost. TikTok floor is the lowest TikTok price that still breaks even (20% fee, shipping from $30).</p></div>
    <div class="row"><label class="t">Keep</label>${seg("cover", ST.cover, [[60, "60 days"], [90, "90 days"], [180, "180 days"]])}</div></div>
    ${table("overstock", [PROD, TIER,
      { h: "Live inv", v: r => r._qoh },
      { h: "Day ave", v: dayFor, t: "1" },
      { h: "Days of stock", v: r => r._xsDays, f: r => r._xsDays == null ? "<span class=muted>no sales</span>" : fmtInt(r._xsDays) },
      { h: "Excess units", v: r => r._xs, total: true },
      { h: "Cash tied up", v: r => r._xsValue, t: "usd", total: true },
      { h: "TikTok price", v: r => r._live.tiktok, t: "usd" },
      { h: "TikTok floor", v: r => r._floor, t: "usd", tip: "Break-even TikTok price" },
      { h: "Action", v: r => r._action, l: true, f: r => `<span class="pill ${dayFor(r) <= 0 ? "bad" : r._xsDays > 365 ? "warn" : "muted"}">${esc(r._action)}</span>` },
    ], over, { sort: 6, onRow: showDetail, main: "overstock" })}</section>
  <section class="card"><div class="head"><div><h3>Switch vendor: cheaper quotes</h3>
    <p class="hint" style="margin:0">Selling products where the cheapest vendor quote is under what you pay now (platform cost). Yearly savings = saving per unit × day average × 365. Confirm the quote before ordering.</p></div>
    <div class="row"><label class="t">Show</label>${seg("vf", ST.vf, [["all", "All quotes"], ["solid", "Recent quotes only"]])}</div></div>
    ${table("savings", [PROD,
      { h: "Current vendor", v: r => r._vendor, t: "text", l: true },
      { h: "Pay now", v: r => r._AN, t: "usd" },
      { h: "Best quote", v: r => r._best, t: "usd" },
      { h: "From", v: r => VENDORS[r._bestVendor], t: "text", l: true },
      { h: "Quote date", v: r => r._qDate, f: qDate },
      { h: "Save / unit", v: r => r._save, t: "usd" },
      { h: "Day ave", v: dayFor, t: "1" },
      { h: "On next order", v: r => r._orderSave, t: "usd", total: true, tip: "Saving per unit × the reorder quantity" },
      { h: "Per year", v: r => r._yearSave, t: "usd", total: true },
      { h: "Check", v: r => r._note, l: true, f: r => r._note ? `<span class="pill warn">${esc(r._note)}</span>` : `<span class="pill good">ok</span>` },
    ], save, { sort: 9, onRow: showDetail, main: "vendor-savings" })}</section>`;
}

// ---------- Vendors ----------
function vendorsHtml() {
  if (!ST.vendor) {
    const vl = Object.keys(VENDORS).map(k => {
      const items = rows.filter(r => r._prices.some(x => x.k === k));
      const dates = items.map(r => r._prices.find(x => x.k === k).date).filter(Boolean);
      return { k, items, cheapest: items.filter(r => r._bestVendor === k).length, current: rows.filter(r => r._vendor.toLowerCase() === VENDORS[k].toLowerCase()).length,
        last: dates.length ? new Date(Math.max(...dates)) : null };
    }).filter(v => v.items.length);
    return `<p class="lead">Supplier price lists from the API. Click a vendor to look up their prices.</p><section class="card">
      ${table("vend", [
        { h: "Vendor", v: v => VENDORS[v.k], l: true, f: v => `<b>${esc(VENDORS[v.k])}</b>` },
        { h: "Products quoted", v: v => v.items.length },
        { h: "Cheapest on", v: v => v.cheapest },
        { h: "Latest price date", v: v => v.last, f: v => fmtDate(v.last) },
      ], vl, { sort: 1, onRow: v => { ST.vendor = v.k; render(); }, main: "vendors" })}</section>`;
  }
  const k = ST.vendor, items = rows.filter(r => r._prices.some(x => x.k === k));
  const q = r => r._prices.find(x => x.k === k);
  return `<p class="lead"><span class="chip">${esc(VENDORS[k])}<button id="unvendor" title="All vendors">×</button></span> price list. Compare with what you pay now (platform cost) and the cheapest quote.</p>
    <section class="card">${table("vlist", [PROD,
      { h: "Their price", v: r => q(r).price, t: "usd" },
      { h: "Price date", v: r => q(r).date, f: r => fmtDate(q(r).date) },
      { h: "Platform cost", v: r => r._AN, t: "usd" },
      { h: "vs platform cost", v: r => r._AN ? q(r).price - r._AN : null, f: r => { if (!r._AN) return "—"; const d = r._AN - q(r).price; return d > 0.005 ? `<span class=good>${fmtUsd(d)} cheaper</span>` : d < -0.005 ? `<span class=bad>${fmtUsd(-d)} more</span>` : "same"; } },
      { h: "Cheapest", v: r => r._best, f: r => r._bestVendor === k ? `<span class="pill good">cheapest</span>` : `${fmtUsd(r._best)} <span class=muted>${esc(VENDORS[r._bestVendor])}</span>` },
      { h: "Current vendor", v: r => r._vendor, t: "text", l: true },
      { h: "Day ave", v: r => r._day, t: "1" },
      { h: "Order qty", v: r => r._orderQty },
    ], items, { sort: 1, asc: true, onRow: showDetail, main: `vendor-${k}` })}</section>`;
}

// ---------- TikTok competitors (Euka) ----------
// The server searches Euka's TikTok Shop index for each SKU every few hours (competitors.js);
// this tab compares those listings with our TikTok price and cost.
let COMP = null, compStatus = null, compPoll = null;
async function loadCompetitors(withStatus) {
  try {
    const res = await fetch("/api/competitors", { cache: "no-store" });
    if (res.ok) COMP = await res.json();
    // The server is briefly down while a new version deploys (502): keep what's shown and try again.
    else if (res.status >= 500) { clearTimeout(compPoll); compPoll = setTimeout(() => loadCompetitors().then(() => ST.tab === "competitors" && !$("detail").open && render()), 15000); return; }
    if (withStatus || !compStatus) { const s = await fetch("/api/competitors/status", { cache: "no-store" }); if (s.ok) compStatus = await s.json(); }
  } catch (e) { console.warn("Competitor data unavailable", e); }
  clearTimeout(compPoll);
  if (COMP?.running) compPoll = setTimeout(() => loadCompetitors().then(() => ST.tab === "competitors" && !$("detail").open && render()), 15000);
}
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// TikTok P&L from the sheet: 20% fee, we pay ship when price ≥ $30.
const ttProfit = (r, price) => price == null || r._Q == null ? null : price - price * 0.2 - (price < 30 ? 0 : r._AG) - r._Q;
const ttPct = (r, price) => { const p = ttProfit(r, price); return p == null ? null : p / (r._Q + p); };
// Lowest price that keeps the minimum margin: profit ÷ (Q + profit) ≥ m means profit ≥ Q × m ÷ (1 − m).
function floorPrice(r) {
  if (r._Q == null) return null;
  const m = SET.minMargin / 100, need = m < 1 ? r._Q * m / (1 - m) : Infinity, cents = p => Math.ceil(p * 100 - 1e-6) / 100;
  const free = (r._Q + need) / 0.8;                       // under $30 the buyer pays shipping
  return free < 30 ? cents(free) : cents(Math.max(30, (r._Q + r._AG + need) / 0.8));
}
function compRow(r) {
  const c = COMP?.skus?.[r.sku], m = c?.matches || [];
  // An average selling price (Market Intelligence only, several SKU prices) isn't a listed price.
  const prices = m.filter(x => !x.priceIsAvg).map(x => x.price).filter(x => x > 0);
  const our = r._live.tiktok, low = prices.length ? Math.min(...prices) : null, high = prices.length ? Math.max(...prices) : null;
  const med = median(prices), sold30 = m.reduce((a, x) => a + (x.sold30 || 0), 0), our30 = (r._ch.tt || 0) / 2;
  const floor = floorPrice(r);
  // Suggest a cent under the cheapest competitor, but never below the margin floor.
  const target = low != null ? Math.round((low - 0.01) * 100) / 100 : null;
  const suggest = target == null ? null : floor != null && target < floor ? floor : target;
  return { c, m, our, low, med, high, n: m.length, gap: our != null && low != null ? our - low : null,
    gapPct: our != null && low ? (our - low) / low : null, sold30, our30, share: sold30 + our30 > 0 ? our30 / (sold30 + our30) : null,
    profitLow: ttProfit(r, low), pctLow: ttPct(r, low), floor, suggest, checkedAt: c?.checkedAt, error: c?.error };
}
const CF = { all: "All", undercut: "Undercut", cheapest: "We're cheapest", below: "Comp below our floor", nomatch: "No match", noprice: "No TikTok price" };
function competitorsHtml() {
  const s = compStatus, C = COMP;
  if (!C || !C.configured) {
    return `<p class="lead">TikTok competitor prices come from <b>Euka</b>. Add the API key on the server to turn this on.</p>
      <section class="card"><h3>Set up</h3><p class="hint">In Render, open this service → <b>Environment</b>, add the variables below and save. The first refresh starts on its own within a minute of the restart.</p>
      <div class="tablewrap"><table><thead><tr><th class=l>Variable</th><th class=l>Value</th><th class=l>What it does</th></tr></thead><tbody>
      <tr><td class=l><b>EUKA_API_KEY</b></td><td class=l>euka_openapi_…</td><td class=l>Required. Euka app → Settings → Integrations → OpenAPI keys</td></tr>
      <tr><td class=l>ADMIN_TOKEN</td><td class=l>any password</td><td class=l>Optional. Needed to start refreshes or pin/ignore listings from this page</td></tr>
      <tr><td class=l>OUR_TIKTOK_SHOP_NAMES</td><td class=l>Shop name, Other shop</td><td class=l>Optional. Our own shops, left out of competitors (our listing IDs are already excluded)</td></tr>
      <tr><td class=l>COMPETITORS_PER_SKU</td><td class=l>5</td><td class=l>Competitor listings kept per SKU</td></tr>
      <tr><td class=l>COMPETITOR_REFRESH_HOURS</td><td class=l>12</td><td class=l>How often every SKU is re-checked</td></tr>
      </tbody></table></div><p class="hint" style="margin-top:10px">All settings are listed in <code>.env.example</code> in the repo.</p></section>`;
  }
  const list = rows.map(r => ({ r, x: compRow(r) }));
  const matched = list.filter(o => o.x.n), priced = matched.filter(o => o.x.our != null);
  const under = priced.filter(o => o.x.gap > 0.005), cheapest = priced.filter(o => o.x.gap <= 0.005), below = matched.filter(o => o.x.floor != null && o.x.low < o.x.floor);
  const f = ST.compFilter || "all";
  const shown = { all: list, undercut: under, cheapest, below, nomatch: list.filter(o => !o.x.n), noprice: matched.filter(o => o.x.our == null) }[f] || list;
  // Each SKU is re-searched only when its result is older than the refresh window; results are overwritten one by one.
  const fresh = Object.values(C.skus || {}).filter(x => x.checkedAt && Date.now() - Date.parse(x.checkedAt) < C.refreshHours * 36e5).length;
  const run = (C.running ? `<b>Searching:</b> ${fmtInt(C.progress.done)} of ${fmtInt(C.progress.total)} due SKUs… `
    : "") + `${fmtInt(fresh)} SKUs searched in the last ${C.refreshHours} hours${C.errors ? ` · <span class=warn>${C.errors} failed last pass</span>` : ""}${!C.running && C.nextRunAt ? ` · next due ${new Date(C.nextRunAt).toLocaleString()}` : ""}.`
    + (C.quotaUntil ? ` <span class="pill bad">Euka's weekly limit is used up. Searching resumes ${new Date(C.quotaUntil).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>` : "")
    + (C.saved && !C.saved.persistent ? ` <span class="pill bad" title="Results are kept on the server's temporary disk">Results reset when the server restarts</span>` : "");
  const key = s && s.keyOk === false ? `<span class="pill bad">Euka key problem: ${esc(s.error)}</span>` : "";
  const mi = C.marketIntel?.ok === false && (C.sources || []).includes("market")
    ? `<span class="pill bad" title="${esc(C.marketIntel.error || "")}">Market intelligence unavailable, using product search only</span>` : "";
  const avgGap = priced.length ? sum(priced, o => o.x.gapPct) / priced.length : null;
  const kpis = `<section class="kpis">
    <div class="kpi"><div class="label">SKUs with competitors</div><div class="value">${fmtInt(matched.length)}</div><div class="sub">of ${fmtInt(list.length)} · up to ${C.perSku} each</div></div>
    <button class="kpi ${under.length ? "alert" : ""}" data-cf="undercut"><div class="label">We're undercut</div><div class="value">${fmtInt(under.length)}</div><div class="sub">a competitor sells for less</div></button>
    <button class="kpi" data-cf="cheapest"><div class="label">We're cheapest</div><div class="value">${fmtInt(cheapest.length)}</div><div class="sub">at or below every match</div></button>
    <div class="kpi"><div class="label">Average gap vs lowest</div><div class="value">${avgGap == null ? "—" : (avgGap > 0 ? "+" : "") + fmtPct(avgGap)}</div><div class="sub">our price vs cheapest competitor</div></div>
    <button class="kpi" data-cf="below"><div class="label">Competitor below our floor</div><div class="value">${fmtInt(below.length)}</div><div class="sub">can't match and keep ${SET.minMargin}% margin</div></button>
    <div class="kpi"><div class="label">Competitor units, 30 days</div><div class="value">${fmtInt(sum(matched, o => o.x.sold30))}</div><div class="sub">across matched listings (Euka estimate)</div></div>
  </section>`;
  const cols = [PROD, TIER,
    { h: "Our price", v: o => o.x.our, t: "usd", grp: "TikTok price" },
    { h: "Lowest", v: o => o.x.low, t: "usd", grp: "Competitors" },
    { h: "Median", v: o => o.x.med, t: "usd", grp: "Competitors" },
    { h: "Highest", v: o => o.x.high, t: "usd", grp: "Competitors" },
    { h: "Listings", v: o => o.x.n, grp: "Competitors" },
    { h: "Gap vs lowest", v: o => o.x.gapPct, grp: "Position", f: o => o.x.gapPct == null ? "<span class=muted>—</span>"
      : `<span class="${o.x.gap > 0.005 ? "bad" : "good"}">${o.x.gap > 0 ? "+" : ""}${fmtUsd(o.x.gap)} (${fmtPct(o.x.gapPct)})</span>` },
    { h: "Comp units 30d", v: o => o.x.sold30, grp: "Demand", tip: "Units sold in the last 30 days by the matched listings (Euka)" },
    { h: "Our units 30d", v: o => o.x.our30, grp: "Demand", tip: "Half of our TikTok 60-day units" },
    { h: "Our share", v: o => o.x.share, t: "pct", grp: "Demand" },
    { h: "Profit at lowest", v: o => o.x.profitLow, f: o => money(o.x.profitLow), grp: "If we match", tip: "TikTok P&L at the cheapest competitor's price" },
    { h: "PFT% at lowest", v: o => o.x.pctLow, f: o => pctPill(o.x.pctLow), grp: "If we match" },
    { h: "Floor price", v: o => o.x.floor, t: "usd", grp: "If we match", tip: `Lowest price that keeps ${SET.minMargin}% margin` },
    { h: "Suggested", v: o => o.x.suggest, grp: "If we match", f: o => o.x.suggest == null ? "<span class=muted>—</span>"
      : `<b>${fmtUsd(o.x.suggest)}</b>${o.x.floor != null && o.x.suggest === o.x.floor && o.x.low < o.x.floor ? `<span class=calc>floor</span>` : ""}`, tip: "A cent under the cheapest competitor, never below the floor" },
    { h: "Checked", v: o => o.x.checkedAt, f: o => o.x.error ? `<span class=bad title="${esc(o.x.error)}">error</span>` : o.x.checkedAt ? new Date(o.x.checkedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "<span class=muted>not yet</span>" },
  ].map(c => c.prod || c === TIER ? { ...c, v: o => c.v(o.r), f: o => c.f(o.r), csv: c.prod ? o => `${o.r.sku} ${o.r.name}` : null } : c);
  return `<p class="lead">Up to ${C.perSku} same-item TikTok Shop listings per SKU from <b>Euka</b>, re-checked every ${C.refreshHours} hours. ${run} ${key}
      ${mi}
      <button id="compRefresh" style="margin-left:8px" ${C.running ? "disabled" : ""} title="Searches SKUs not searched in the last ${C.minGapHours || 2} hours">Refresh all now</button></p>${kpis}
    <section class="card"><div class="head"><h3>Price comparison</h3>
      <div class="seg">${Object.entries(CF).map(([k, v]) => `<button data-cf="${k}" class="${f === k ? "active" : ""}">${v}</button>`).join("")}</div></div>
      <p class="hint">Click a product to see each competitor listing, pin the right one or hide a wrong match.</p>
      ${table("comp", cols, shown, { sort: 7, onRow: o => showCompetitors(o.r), main: "tiktok-competitors", empty: f === "all" ? "No competitor data yet. The first refresh is running or hasn't started." : "Nothing in this group." })}</section>`;
}
function showCompetitors(r) {
  const x = compRow(r), ov = COMP?.overrides?.[r.sku] || {};
  const card = (m, near) => `<tr><td class="l wrap">${m.image ? `<img src="${esc(m.image)}" alt="" width="44" height="44" style="border-radius:6px;object-fit:cover;vertical-align:middle;margin-right:8px">` : ""}
      <a href="https://www.tiktok.com/shop/pdp/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">${esc((m.title || m.id).slice(0, 90))}</a><br><span class=muted>${esc(m.shop || "unknown shop")} · match ${Math.round(m.score * 100)}%${m.pinned ? " · pinned" : ""}${m.creators != null ? ` · ${fmtInt(m.creators)} creators, ${fmtInt(m.videos)} videos` : ""}${m.reviews ? ` · ${fmtInt(m.reviews)} reviews` : ""}</span></td>
    <td>${m.priceIsAvg ? `<span class=muted title="Average selling price over 30 days; not counted in lowest/median">avg ${fmtUsd(m.price)}</span>` : fmtUsd(m.price)}${m.original > m.price ? `<br><span class=muted><s>${fmtUsd(m.original)}</s></span>` : ""}${m.minPrice != null && m.maxPrice > m.minPrice ? `<br><span class=muted title="Cheapest to dearest SKU on this listing">${fmtUsd(m.minPrice)}–${fmtUsd(m.maxPrice)}</span>` : ""}</td><td>${m.shipping ? fmtUsd(m.shipping) : m.shipping === 0 ? "free" : "—"}</td>
    <td>${fmtInt(m.sold30)}${m.growth != null ? `<br><span class="${m.growth >= 0 ? "good" : "bad"}">${m.growth > 0 ? "+" : ""}${Math.round(m.growth)}%</span>` : ""}</td><td>${fmtInt(m.sold)}</td><td>${m.commission != null ? `${+m.commission.toFixed(1)}%` : "—"}</td><td>${m.price != null ? money(ttProfit(r, m.price)) : "—"}</td>
    <td>${near ? `<button data-cact="pin" data-id="${esc(m.id)}" data-sku="${esc(r.sku)}">Pin as match</button>`
      : `${m.pinned ? `<button data-cact="clear" data-id="${esc(m.id)}" data-sku="${esc(r.sku)}">Unpin</button>` : ""} <button data-cact="ignore" data-id="${esc(m.id)}" data-sku="${esc(r.sku)}">Not a match</button>`}</td></tr>`;
  const head = `<thead><tr><th class=l>Listing</th><th>Price</th><th>Ship</th><th>Sold 30d</th><th>Sold total</th><th title="Affiliate commission the seller pays creators">Comm.</th><th>Our profit at this price</th><th></th></tr></thead>`;
  $("dTitle").textContent = `${r.sku} · ${r.name}`;
  $("dSub").innerHTML = `TikTok competitors · our price ${fmtUsd(x.our)} · cost to ship ${fmtUsd(r._Q)} · floor ${fmtUsd(x.floor)} · checked ${x.checkedAt ? new Date(x.checkedAt).toLocaleString() : "not yet"}`;
  $("dBody").innerHTML = `<div class="facts">
      <div><span>Lowest</span>${fmtUsd(x.low)}</div><div><span>Median</span>${fmtUsd(x.med)}</div><div><span>Highest</span>${fmtUsd(x.high)}</div>
      <div><span>Suggested price</span><b>${fmtUsd(x.suggest)}</b></div><div><span>Competitor units 30d</span>${fmtInt(x.sold30)}</div><div><span>Our units 30d</span>${fmtInt(x.our30)}</div></div>
    ${x.error ? `<p class=bad>Last check failed: ${esc(x.error)}</p>` : ""}
    <h4>Matched listings</h4>${x.m.length ? `<div class="tablewrap"><table>${head}<tbody>${x.m.map(m => card(m)).join("")}</tbody></table></div>` : `<p class=muted>No listing matched well enough.</p>`}
    ${x.c?.candidates?.length ? `<h4>Close but not matched</h4><div class="tablewrap"><table>${head}<tbody>${x.c.candidates.map(m => card(m, true)).join("")}</tbody></table></div>` : ""}
    ${(ov.ignore || []).length ? `<h4>Hidden</h4><p>${ov.ignore.map(id => `<span class="chip">${esc(id)}<button data-cact="clear" data-id="${esc(id)}" data-sku="${esc(r.sku)}" title="Show again">×</button></span>`).join(" ")}</p>` : ""}
    <p class="hint" style="margin-top:12px">Searched Euka for: ${(x.c?.queries || []).map(q => `“${esc(q)}”`).join(", ") || "—"}.
      <button data-cact="recheck" data-sku="${esc(r.sku)}">Re-check now</button></p>`;
  if (!$("detail").open) $("detail").showModal();
}
async function compPost(pathname, body) {
  const go = token => fetch(pathname, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) }, body: JSON.stringify(body || {}) });
  let token = ""; try { token = localStorage.getItem("asi-admin-token") || ""; } catch {}
  let res = await go(token);
  if (res.status === 401) {
    token = prompt("Admin token (the ADMIN_TOKEN set on the server):") || "";
    if (!token) return null;
    try { localStorage.setItem("asi-admin-token", token); } catch {}
    res = await go(token);
  }
  const out = await res.json().catch(() => ({}));
  if (res.status === 409) return { message: "A refresh is already running. New results appear as each product is searched." };
  if (!res.ok && res.status !== 202) { alert(out.error || `Request failed (HTTP ${res.status})`); return null; }
  return out;
}
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-cf],[data-cact],#compRefresh");
  if (!t) return;
  e.stopPropagation();
  if (t.dataset.cf) { ST.compFilter = t.dataset.cf; render(); return; }
  t.disabled = true;
  if (t.id === "compRefresh") { const out = await compPost("/api/competitors/refresh"); if (out?.message) alert(out.message); if (out) { await loadCompetitors(); render(); } return; }
  const sku = t.dataset.sku, act = t.dataset.cact;
  const out = act === "recheck" ? await compPost("/api/competitors/refresh", { skus: [sku] }) : await compPost("/api/competitors/override", { sku, productId: t.dataset.id, action: act });
  t.disabled = false;
  if (!out) return;
  await loadCompetitors();
  const r = all.find(x => x.sku === sku); if (r) showCompetitors(r);
  if (ST.tab === "competitors") render();
}, true);

// ---------- detail ----------
function showDetail(r) {
  $("dTitle").textContent = `${r.sku} · ${r.name}`;
  $("dSub").innerHTML = `${tierTag(r)} ${esc(r.category || "")} · UPC ${esc(r.upc || "—")} · supplier ${esc(r._vendor)}`;
  const f = (l, v) => `<div><span>${l}</span>${v}</div>`;
  const chs = Object.keys(CHANNELS).filter(k => r._ch[k] > 0).sort((a, b) => r._ch[b] - r._ch[a]);
  $("dBody").innerHTML = `<div class="facts">
      ${f("Live inv", fmtInt(r._qoh))}${f("On order", fmtInt(r._inProg))}${f("Days of stock", daysPill(r._days))}
      ${f(`Sold (${SET.window}-day window)`, fmtInt(r._sold))}${f("Day ave", fmt1(r._day))}${f("Monthly", fmtInt(r._monthly))}
      ${f("Reorder point", fmtInt(r._rop))}${f("Order qty", `${fmtInt(r._orderQty)} (${fmtInt(r._cases)} cases)`)}${f("Order cost", fmtUsd(r._orderCost))}
      ${f("Total cost to ship (Q)", fmtUsd(r._Q))}${f("Platform cost", fmtUsd(r._AN))}${f("Ship charge", fmtUsd(r._AG))}
      ${f("Wholesale cost", fmtUsd(r._AS))}${f("Case qty", fmtInt(r._caseQty))}${f("Last ordered", `${esc(r.last_ordered_date || "—")} · ${esc(r.last_ordered_name || "")}`)}
    </div>
    <h4>Projected sales</h4><div class="facts">${PERIODS.map(n => f(`Next ${n} days`, `${fmtInt(r._day * n)} <span class=muted>· stock after ${fmtInt(r._qoh - r._day * n)}</span>`)).join("")}</div>
    <h4>Platforms (60-day units and P&L)</h4>
    <div class="tablewrap"><table><thead><tr><th class=l>Platform</th><th>60 days</th><th>Price</th><th>Fees</th><th>Ship</th><th>Profit</th><th>PFT%</th><th>60-day profit</th></tr></thead><tbody>
    ${Object.keys(CHANNELS).sort((a, b) => r._ch[b] - r._ch[a]).map(ch => { const x = PL_BY_CH[ch], L = x ? r._pl[x.k] : null;
      return `<tr><td class=l>${CHANNELS[ch]}</td><td>${fmtInt(r._ch[ch])}</td><td>${L?.price != null ? fmtUsd(L.price) + (L.src === "Excel formula" ? `<span class=calc>calc</span>` : "") : "<span class=muted>—</span>"}</td>
        <td>${L?.price != null ? fmtUsd(L.fee) : ""}</td><td>${L?.price != null ? fmtUsd(L.ship) : ""}</td><td>${L?.price != null ? money(L.profit) : ""}</td><td>${L?.price != null ? pctPill(L.pct) : ""}</td><td>${L?.price != null ? money(L.profit60) : ""}</td></tr>`; }).join("")}
    </tbody></table></div>
    <h4>Vendor quotes</h4>${r._prices.length ? `<div class="facts">${r._prices.map((x, i) => f(VENDORS[x.k] + (i === 0 ? " · cheapest" : ""), `${fmtUsd(x.price)} <span class=muted>${fmtDate(x.date)}</span>`)).join("")}</div>` : `<p class=muted>No vendor quotes in the API.</p>`}`;
  $("detail").showModal();
  window.excelPanel?.(r);
}

// ---------- CSV ----------
function exportCsv() {
  if (!lastTable) return;
  const strip = s => String(s).replace(/<[^>]+>/g, "");
  const cell = v => { v = v instanceof Date ? dayKey(v) : v ?? ""; const s = typeof v === "number" ? String(Math.round(v * 1000) / 1000) : strip(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = lastTable.cols;
  const lines = [cols.map(c => cell(strip(c.h))).join(","), ...lastTable.list.map(r => cols.map(c => cell(c.csv ? c.csv(r) : c.prod ? `${r.sku} ${r.name}` : c.v(r))).join(","))];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `${lastTable.name}-${dayKey(new Date())}.csv`; a.click();
}

// ---------- events ----------
// One click listener for the whole page; each control is recognised by its data-* attribute or id.
document.addEventListener("click", e => {
  const t = e.target.closest("[data-go],[data-ss],[data-show],[data-pf],[data-cover],[data-vf],[data-h],[data-tbl][data-page],[data-cols],th[data-t],tr[data-t],.dd-trigger,.lead,#ungroup,#unvendor,#resetSet,#clearMasterFilter,#resetFilters,#clearSearch,[data-expand]");
  if (!t) return;
  if (t.matches("#fPlat, #fCat, #fTier")) openFilter(t.id);                                  // top bar filters
  else if (t.id === "resetFilters") resetFilters();
  else if (t.id === "clearSearch") { query = ""; $("q").value = ""; ui.menu.close(); apply(); }
  else if (t.dataset.expand) toggleExpand(t.dataset.expand);
  else if (t.id === "groupBy") ui.selectMenu(t, Object.entries(GROUPS).map(([k, v]) => ({ value: k, label: v[0] })), ST.group, v => { ST.group = v; ST.groupPick = null; render(); });
  else if (t.dataset.cols) openColumnPicker(t.dataset.cols);                                // "Columns" picker
  else if (t.dataset.tbl && t.dataset.page) { PAGE[t.dataset.tbl].page = +t.dataset.page; render(); t.closest(".card")?.scrollIntoView({ block: "nearest" }); }
  else if (t.classList.contains("lead")) t.classList.toggle("open");                         // phone: expand the clamped description
  else if (t.dataset.ss) { ST.soldShow = t.dataset.ss; render(); }
  else if (t.dataset.h) { ST.horizon = +t.dataset.h; render(); }
  else if (t.dataset.go) {                                                                   // Overview tile → Product master, filtered
    const f = TILE_FILTERS[t.dataset.go];
    if (!f) return;
    ST.tab = "master"; ST.masterFilter = t.dataset.go; ST.groupPick = null; ST.vendor = "";
    const i = masterCols().findIndex(c => colKey(c) === f.sort[0]);
    if (i >= 0) SORT.master = { i, asc: f.sort[1] };
    if (PAGE.master) PAGE.master.page = 1;
    render(); window.scrollTo(0, 0);
  }
  else if (t.dataset.show) { ST.show = t.dataset.show; render(); }
  else if (t.dataset.pf) { ST.plFilter = t.dataset.pf; render(); }
  else if (t.dataset.cover) { ST.cover = +t.dataset.cover; render(); }
  else if (t.dataset.vf) { ST.vf = t.dataset.vf; render(); }
  else if (t.id === "clearMasterFilter") { ST.masterFilter = ""; render(); }
  else if (t.id === "ungroup") { ST.groupPick = null; render(); }
  else if (t.id === "unvendor") { ST.vendor = ""; render(); }
  else if (t.id === "resetSet") { SET = { ...SETTING_DEFAULTS }; saveSettings(); reEnrich(); }
  else if (t.tagName === "TH") { const s = SORT[t.dataset.t], i = +t.dataset.i; if (s.i === i) s.asc = !s.asc; else { s.i = i; s.asc = false; } render(); }
  else if (t.tagName === "TR") { const tb = TABLES[t.dataset.t]; tb?.onRow?.(tb.list[+t.dataset.r]); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.size !== undefined) { PAGE[t.dataset.tbl] = { page: 1, size: +t.value }; render(); }   // rows per page
  else if (t.id === "livePrices") { SET.livePrices = t.checked; saveSettings(); reEnrich(); }
  else if (t.dataset.set) { const v = +t.value; if (v > 0 || (t.dataset.set === "minMargin" && v >= 0)) { SET[t.dataset.set] = v; saveSettings(); reEnrich(); } }
});
document.addEventListener("toggle", e => { if (e.target.matches?.("details.settings")) settingsOpen = e.target.open; }, true);
document.addEventListener("themechange", () => all.length && render());   // charts take their colors from the theme
$("dClose").onclick = () => $("detail").close();
$("detail").addEventListener("click", e => { if (e.target === $("detail")) $("detail").close(); });
$("reload").onclick = () => load(true);
$("csv").onclick = exportCsv;
mountSearch();
{ const h = location.hash.slice(1); ST.tab = TABS[shell.OLD_VIEWS[h] || h] ? (shell.OLD_VIEWS[h] || h) : TABS[ST.tab] ? ST.tab : "overview"; }
// Side navigation links are /#view: switch views in place.
addEventListener("hashchange", () => { const t = location.hash.slice(1); if (t !== ST.tab) goTab(t); });
// Signed-in session (auth.js): send the user back to sign in when it runs out or the server says so.
if (location.protocol.startsWith("http")) {
  const toLogin = () => location.assign("/login?next=" + encodeURIComponent(location.pathname + location.hash));
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    const u = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
    if (res.status === 401 && u.origin === location.origin && u.pathname.startsWith("/api/") && res.headers.get("content-type")?.includes("json")) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.login) toLogin();
    }
    return res;
  };
  origFetch("/api/session", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(s => {
    const left = s?.expiresAt ? Date.parse(s.expiresAt) - Date.now() : null;
    if (left != null) setTimeout(toLogin, Math.max(0, Math.min(left, 2 ** 31 - 1)));
  }).catch(() => {});
}
load();
if (location.protocol.startsWith("http")) loadCompetitors(true).then(() => { if (all.length && ST.tab === "competitors") render(); });
