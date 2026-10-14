// Edits from the dashboard written into the Excel workbook in OneDrive / SharePoint through Microsoft Graph.
// The server signs in as an Entra app (client credentials), finds the SKU's row on the sheet by the
// "SKU #" column, and writes cells the same way a co-author typing in Excel Online would, so anything
// that reacts to changes in the file (the QuickBooks sync) sees them.
// Safety: editing needs ADMIN_TOKEN; formula cells are never overwritten; values starting with "=" are
// refused; each change is checked against the value the page last saw, so a newer edit made in Excel
// isn't silently replaced. Every change is appended to excel-edits.jsonl in the data dir.
const fs = require("fs");
const path = require("path");

const env = (k, d) => (process.env[k] ?? "").trim() || d;
const CFG = {
  tenant: env("MS_TENANT_ID", ""),
  clientId: env("MS_CLIENT_ID", ""),
  secret: env("MS_CLIENT_SECRET", ""),
  // Either a link to the file (share link or the address bar URL from OneDrive/SharePoint)...
  fileUrl: env("EXCEL_FILE_URL", ""),
  // ...or the owner's sign-in and the path inside their OneDrive.
  user: env("EXCEL_USER", "office@americanseairimports.onmicrosoft.com"),
  filePath: env("EXCEL_PATH", "TIKTOK PRICING 786110.xlsx"),
  sheet: env("EXCEL_SHEET", "0. MASTER"),
  skuHeader: env("EXCEL_SKU_HEADER", "SKU #"),
  headerRow: +env("EXCEL_HEADER_ROW", "0"), // 0 = find the row holding the SKU header
  locked: env("EXCEL_LOCKED_COLUMNS", "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
  adminToken: env("ADMIN_TOKEN", ""),
  dataDir: env("EXCEL_DATA_DIR", env("COMPETITOR_DATA_DIR", path.join(__dirname, "data"))),
  graph: env("MS_GRAPH_BASE", "https://graph.microsoft.com/v1.0").replace(/\/+$/, ""),
  login: env("MS_LOGIN_BASE", "https://login.microsoftonline.com").replace(/\/+$/, ""),
  layoutMs: 5 * 60 * 1000,
};
const LOG = () => path.join(CFG.dataDir, "excel-edits.jsonl");
const missing = () => [["MS_TENANT_ID", CFG.tenant], ["MS_CLIENT_ID", CFG.clientId], ["MS_CLIENT_SECRET", CFG.secret]].filter(x => !x[1]).map(x => x[0]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Graph ----------
let token = { value: "", exp: 0 };
async function accessToken() {
  if (token.value && Date.now() < token.exp - 60000) return token.value;
  const res = await fetch(`${CFG.login}/${encodeURIComponent(CFG.tenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CFG.clientId, client_secret: CFG.secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft sign-in failed: ${out.error_description?.split("\r\n")[0] || out.error || `HTTP ${res.status}`}`);
  token = { value: out.access_token, exp: Date.now() + (out.expires_in || 3600) * 1000 };
  return token.value;
}

async function graph(method, p, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(CFG.graph + p, {
      method, headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (res.ok) return out;
    // Throttled, or Excel is busy (another edit holding the file): wait and try again.
    if ([429, 503, 504].includes(res.status) && attempt < 4) { await sleep((+res.headers.get("retry-after") || attempt * 2) * 1000); continue; }
    const msg = out.error?.innerError?.message || out.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Microsoft Graph ${method} failed: ${msg}`), { status: res.status, code: out.error?.code });
  }
}

let item = null; // { base, name, webUrl }
async function workbook() {
  if (item) return item;
  let d;
  if (CFG.fileUrl) d = await graph("GET", `/shares/u!${Buffer.from(CFG.fileUrl).toString("base64url")}/driveItem?$select=id,name,webUrl,parentReference`);
  else d = await graph("GET", `/users/${encodeURIComponent(CFG.user)}/drive/root:/${CFG.filePath.split("/").map(encodeURIComponent).join("/")}?$select=id,name,webUrl,parentReference`);
  item = { base: `/drives/${d.parentReference.driveId}/items/${d.id}/workbook`, name: d.name, webUrl: d.webUrl };
  return item;
}
const sheetPath = () => `/worksheets('${encodeURIComponent(CFG.sheet.replace(/'/g, "''"))}')`;
const rangePath = a => `${sheetPath()}/range(address='${a}')`;

// ---------- sheet layout ----------
const colName = n => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = s => [...s.toUpperCase()].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
const norm = s => String(s ?? "").replace(/\s+/g, " ").trim().toUpperCase();
const skuKey = s => String(s ?? "").replace(/\s+/g, "").toUpperCase();
const sameValue = (a, b) => String(a ?? "") === String(b ?? "");

let layout = null; // { at, headerRow, firstCol, lastCol, columns: [{col, header}], rows: Map(skuKey -> row number) }
async function getLayout(force) {
  if (!force && layout && Date.now() - layout.at < CFG.layoutMs) return layout;
  const wb = await workbook();
  const used = await graph("GET", `${wb.base}${sheetPath()}/usedRange(valuesOnly=true)?$select=address,rowCount,columnCount`);
  const m = used.address.split("!").pop().match(/^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/);
  if (!m) throw new Error(`Unexpected sheet range ${used.address}`);
  const firstCol = colIndex(m[1]), lastCol = colIndex(m[3] || m[1]), lastRow = +(m[4] || m[2]);
  // Headers are within the first rows (the master tab has notes rows above them).
  const top = await graph("GET", `${wb.base}${rangePath(`A1:${colName(lastCol)}${Math.min(lastRow, 40)}`)}?$select=values`);
  let headerRow = CFG.headerRow, skuCol = -1;
  for (let r = 0; r < top.values.length && skuCol < 0; r++) {
    if (headerRow && r + 1 !== headerRow) continue;
    const i = top.values[r].findIndex(v => norm(v) === norm(CFG.skuHeader));
    if (i >= 0) { headerRow = r + 1; skuCol = i; }
  }
  if (skuCol < 0) throw new Error(`Couldn't find a "${CFG.skuHeader}" header on sheet "${CFG.sheet}"`);
  const heads = top.values[headerRow - 1];
  const seen = {};
  const columns = heads.map((h, i) => ({ col: colName(i), header: norm(h) })).filter(c => c.header);
  for (const c of columns) seen[c.header] = (seen[c.header] || 0) + 1;
  for (const c of columns) c.label = seen[c.header] > 1 ? `${c.header} (${c.col})` : c.header;
  const skuColName = colName(skuCol);
  const skus = await graph("GET", `${wb.base}${rangePath(`${skuColName}${headerRow + 1}:${skuColName}${Math.max(lastRow, headerRow + 1)}`)}?$select=values`);
  const rows = new Map();
  skus.values.forEach((v, i) => { const k = skuKey(v[0]); if (k && !rows.has(k)) rows.set(k, headerRow + 1 + i); });
  layout = { at: Date.now(), headerRow, firstCol, lastCol, skuCol: skuColName, columns, rows };
  return layout;
}

async function readRow(sku, retry = true) {
  let L = await getLayout(), row = L.rows.get(skuKey(sku));
  if (!row) { L = await getLayout(true); row = L.rows.get(skuKey(sku)); } // a row may have been added since
  if (!row) return null;
  const wb = await workbook();
  const r = await graph("GET", `${wb.base}${rangePath(`A${row}:${colName(L.lastCol)}${row}`)}?$select=values,formulas,text`);
  const at = col => { const i = colIndex(col); return { value: r.values[0][i], formula: r.formulas[0][i], text: r.text[0][i] }; };
  // The sheet may have been re-sorted since the layout was read; refresh once if the SKU moved.
  if (skuKey(at(L.skuCol).value) !== skuKey(sku)) { layout = null; return retry ? readRow(sku, false) : null; }
  const cells = L.columns.map(c => {
    const x = at(c.col), isFormula = typeof x.formula === "string" && x.formula.startsWith("=");
    const reason = c.col === L.skuCol ? "SKU column" : isFormula ? "formula" : CFG.locked.includes(c.col) || CFG.locked.includes(c.header) ? "locked" : "";
    return { col: c.col, header: c.header, label: c.label, value: x.value, text: x.text, editable: !reason, reason, ...(isFormula ? { formula: x.formula } : {}) };
  });
  return { sku, row, sheet: CFG.sheet, cells };
}

// changes: [{ col, header, expected, value }]
async function edit(sku, changes, editor) {
  const cur = await readRow(sku);
  if (!cur) throw Object.assign(new Error(`SKU ${sku} isn't on sheet "${CFG.sheet}"`), { status: 404 });
  const wb = await workbook(), results = [];
  for (const ch of changes) {
    const c = cur.cells.find(x => x.col === String(ch.col || "").toUpperCase());
    const value = ch.value == null ? "" : String(ch.value);
    const fail = error => results.push({ col: ch.col, header: ch.header, ok: false, error });
    if (!c) { fail("That column is outside the sheet's headers"); continue; }
    if (ch.header && norm(ch.header) !== c.header) { fail(`Column ${c.col} is now "${c.header}", not "${norm(ch.header)}". Reload and try again.`); continue; }
    if (!c.editable) { fail({ formula: `${c.label} is a formula in Excel and can't be typed over`, "SKU column": "The SKU column can't be changed from the dashboard", locked: `${c.label} is locked (EXCEL_LOCKED_COLUMNS)` }[c.reason]); continue; }
    if (/^\s*=/.test(value)) { fail("Formulas can't be entered from the dashboard"); continue; }
    if ("expected" in ch && !sameValue(ch.expected, c.value)) { fail(`${c.label} was changed in Excel to "${c.text}" since you opened it`); continue; }
    if (sameValue(value, c.value)) { results.push({ col: c.col, header: c.header, ok: true, unchanged: true, value: c.value, text: c.text }); continue; }
    const out = await graph("PATCH", `${wb.base}${rangePath(`${c.col}${cur.row}`)}`, { values: [[value]] });
    const entry = { at: new Date().toISOString(), editor: String(editor || "").slice(0, 60) || null, sku, row: cur.row, col: c.col, header: c.header, from: c.value, to: out.values?.[0]?.[0] ?? value };
    appendLog(entry);
    results.push({ col: c.col, header: c.header, ok: true, value: entry.to, text: out.text?.[0]?.[0] ?? value });
  }
  return { sku, row: cur.row, results };
}

function appendLog(entry) {
  try { fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.appendFileSync(LOG(), JSON.stringify(entry) + "\n"); }
  catch (e) { console.warn(`Couldn't save Excel edit log: ${e.message}`); }
  console.log(`Excel edit: ${entry.sku} ${entry.header} (${entry.col}${entry.row}) ${JSON.stringify(entry.from)} -> ${JSON.stringify(entry.to)}${entry.editor ? ` by ${entry.editor}` : ""}`);
}
function readLog(limit) {
  try { return fs.readFileSync(LOG(), "utf8").trim().split("\n").filter(Boolean).slice(-limit).map(l => JSON.parse(l)).reverse(); }
  catch { return []; }
}

// ---------- HTTP ----------
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((resolve, reject) => {
  let b = ""; req.on("data", c => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on("error", reject);
});
const authorized = (req, url) => CFG.adminToken && (req.headers["x-admin-token"] === CFG.adminToken || url.searchParams.get("token") === CFG.adminToken);

// Returns true when it handled the request.
async function handle(req, res, url) {
  if (!url.pathname.startsWith("/api/excel")) return false;
  const sub = url.pathname.slice("/api/excel".length);
  try {
    if (sub === "" || sub === "/") {
      const info = { configured: !missing().length, missing: missing(), canEdit: !!CFG.adminToken, sheet: CFG.sheet, file: CFG.fileUrl || `${CFG.user}: ${CFG.filePath}` };
      if (!info.configured) return send(res, 200, info), true;
      try {
        const wb = await workbook(), L = await getLayout(url.searchParams.has("refresh"));
        return send(res, 200, { ...info, ok: true, name: wb.name, webUrl: wb.webUrl, headerRow: L.headerRow, rows: L.rows.size, columns: L.columns.map(c => ({ col: c.col, header: c.header, label: c.label })) }), true;
      } catch (e) { return send(res, 200, { ...info, ok: false, error: e.message }), true; }
    }
    if (missing().length) return send(res, 400, { error: `Excel isn't connected: set ${missing().join(", ")} on the server` }), true;
    if (sub === "/row") {
      const sku = url.searchParams.get("sku");
      if (!sku) return send(res, 400, { error: "sku is required" }), true;
      const r = await readRow(sku);
      return r ? send(res, 200, r) : send(res, 404, { error: `SKU ${sku} isn't on sheet "${CFG.sheet}"` }), true;
    }
    if (sub === "/log") return send(res, 200, { edits: readLog(Math.min(500, +url.searchParams.get("limit") || 100)) }), true;
    if (sub === "/edit") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" }), true;
      if (!CFG.adminToken) return send(res, 403, { error: "Set ADMIN_TOKEN on the server to turn on editing" }), true;
      if (!authorized(req, url)) return send(res, 401, { error: "Admin token required" }), true;
      const { sku, changes, editor } = await readBody(req);
      if (!sku || !Array.isArray(changes) || !changes.length || changes.length > 200) return send(res, 400, { error: "sku and changes [{ col, header, expected, value }] are required" }), true;
      return send(res, 200, await edit(String(sku), changes, editor)), true;
    }
    return send(res, 404, { error: "Unknown excel endpoint" }), true;
  } catch (e) {
    console.error(`${url.pathname} failed: ${e.message}`);
    return send(res, e.status === 404 ? 404 : 502, { error: e.message }), true;
  }
}

module.exports = { handle, CFG, _test: { colName, colIndex, skuKey, reset: () => { item = null; layout = null; token = { value: "", exp: 0 }; } } };
