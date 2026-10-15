// Catalog management page (catalog-admin.html): the owner adds and removes customer catalogs (Catalog 1 at /catalog,
// Catalog N at /catalogN; add/remove go through /api/catalog/add and /api/catalog/remove), and for each one names it, turns it on or off, chooses whether piece and case prices show, sets its password, and picks
// which SKUs are in it, with optional per-SKU prices. Settings are saved through /api/catalog/settings
// (catalog.js); each catalog and its PDF/Excel downloads follow them within a minute.
// Uses $, esc, fmtUsd, ST and render from catalog-admin.html, and ui.js for the filter menu.
(() => {
  // Page styles on top of ads.css: catalog tabs, setting toggles, the pricing rule fields and the sticky save bar.
  const css = document.createElement("style");
  css.textContent = `
    .ca-tabs { display: flex; gap: 0; margin: -4px 0 16px; border-bottom: 2px solid var(--ds-border); overflow-x: auto; }
    .ca-tabs button { background: none; border-radius: 0; margin-bottom: -2px; padding: 8px 12px; color: var(--ds-text-subtle); border-bottom: 2px solid transparent; }
    .ca-tabs button:hover { background: none; color: var(--ds-text); }
    .ca-tabs button.active { background: none; color: var(--ds-text-selected); border-bottom-color: var(--ds-border-selected); }
    .ca-tabs small { font-weight: 400; color: var(--ds-text-subtlest); margin-left: 6px; }
    .ca-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 12px 0 16px; }
    .ca-box { background: var(--ds-surface-sunken); border-radius: 6px; padding: 12px 14px; }
    .ca-box h4 { margin: 0 0 8px; font: 600 12px/16px var(--ds-font); color: var(--ds-text-subtle); }
    /* ADS Toggle: a switch with its label and help text. */
    .ca-toggle { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; padding: 4px 0; }
    .ca-toggle + .ca-toggle { margin-top: 6px; }
    .ca-toggle input { appearance: none; -webkit-appearance: none; flex: none; width: 32px; height: 16px; border-radius: 8px; margin: 2px 0 0; position: relative;
      background: var(--ds-text-subtlest); cursor: pointer; transition: background .15s; }
    .ca-toggle input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .ca-toggle input:checked { background: var(--ds-text-success); } .ca-toggle input:checked::after { transform: translateX(16px); }
    .ca-toggle b { display: block; font-weight: 600; } .ca-toggle small { display: block; color: var(--ds-text-subtlest); font-size: 12px; line-height: 16px; }
    .ca-choice { display: flex; gap: 10px; align-items: flex-start; padding: 4px 0; cursor: pointer; } .ca-choice input { margin-top: 2px; }
    .ca-choice small { display: block; color: var(--ds-text-subtlest); font-size: 12px; line-height: 16px; }
    /* Text field with a unit after it, e.g. [ 12 | % ]. */
    .ca-rule { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .ca-field { flex: none; display: inline-flex; align-items: stretch; border: 1px solid var(--ds-border-input); border-radius: 3px; background: var(--ds-bg-input); overflow: hidden; }
    .ca-field:focus-within { border-color: var(--ds-border-focused); box-shadow: inset 0 0 0 1px var(--ds-border-focused); }
    .ca-field input { border: 0; width: 72px; text-align: right; box-shadow: none; background: none; }
    .ca-rule.stack { flex-direction: column; align-items: stretch; }
    .ca-rule.stack .seg { display: grid; grid-template-columns: repeat(auto-fit, minmax(38px, 1fr)); }
    .ca-rule.stack .seg button { padding: 0 4px; }
    .ca-field span { display: grid; place-items: center; padding: 0 8px; color: var(--ds-text-subtle); background: var(--ds-bg-neutral); font-weight: 600; }
    .ca-tabs .ca-add { margin-left: auto; flex: none; color: var(--ds-link); }
    .ca-tabs .ca-add:hover { color: var(--ds-link); text-decoration: underline; }
    .ca-remove { color: var(--ds-text-danger); }
    .ca-pw { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
    .ca-pw input { flex: 0 1 260px; }
    .ca-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .ca-bar input[type=search] { flex: 1 1 220px; max-width: 360px; }
    #caTable td:nth-child(2) { max-width: 190px; white-space: normal; overflow-wrap: break-word; }
    #caTable td:nth-child(3) { min-width: 300px; white-space: normal; }
    #caTable td input[type=number] { width: 92px; text-align: right; }
    #caTable tr.off td { color: var(--ds-text-subtlest); }
    #caTable tr.off td:nth-child(3) { text-decoration: line-through; }
    .ca-save { position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 0 -16px -16px; padding: 12px 16px;
      background: var(--ds-surface-raised); border-top: 1px solid var(--ds-border); border-radius: 0 0 8px 8px; }`;
  document.head.appendChild(css);

  const CA = { data: null, cur: "1", per: {}, loading: false, error: "", q: "", filter: "all", saving: false, limit: 300 };
  // draft, dirty, msg and newPassword belong to the catalog being edited.
  for (const k of ["draft", "dirty", "msg", "newPassword"]) Object.defineProperty(CA, k, { get: () => (CA.per[CA.cur] ||= {})[k], set: v => { (CA.per[CA.cur] ||= {})[k] = v; } });
  const cur = () => CA.data.catalogs[CA.cur];
  const origin = location.origin;
  const copy = s => JSON.parse(JSON.stringify(s));
  const bySku = () => CA.index || (CA.index = new Map(CA.data.items.map(i => [i.sku, i])));
  const isIn = (i, s = CA.draft) => !s.hidden.includes(i.sku) && (s.added.includes(i.sku) || (s.mode === "all" && i.auto));
  // Same rules as catalog.js pricesFor(): piece = cost + piece markup (or the SKU's own price), case = (cost + case markup) × qty.
  const r2 = n => Math.round(n * 100) / 100;
  const rnd = n => { const t = +CA.draft.roundTo || 0; return t > 0 ? r2(Math.ceil(n / t - 1e-9) * t) : r2(n); };
  const rulePiece = i => i.cost != null ? rnd(i.cost * (1 + (+CA.draft.pieceMarkupPct || 0) / 100)) : null;
  const price = i => CA.draft.prices[i.sku] ?? rulePiece(i);
  const caseUnit = i => i.cost != null ? rnd(i.cost * (1 + (+CA.draft.caseMarkupPct || 0) / 100)) : null;
  const usd = v => v == null ? "<span class=muted>Contact Sales</span>" : fmtUsd(v);
  const ROUNDING = [[0, "None"], [0.05, "5¢"], [0.1, "10¢"], [0.25, "25¢"], [0.5, "50¢"], [1, "$1"]];
  const when = t => t ? new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";

  async function load() {
    CA.loading = true; CA.error = "";
    try {
      const r = await fetch("/api/catalog/settings", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      CA.data = d; CA.index = null;
      for (const id of Object.keys(d.catalogs)) { const p = (CA.per[id] ||= {}); if (!p.dirty) p.draft = copy(d.catalogs[id]); }
    } catch (e) { CA.error = e.message; }
    CA.loading = false;
    if (ST.tab === "catalog") render();
  }

  window.catalogAdminHtml = () => {
    if (!CA.data && !CA.loading && !CA.error) load();
    if (!CA.data) return `<section class="card"><h3>Customer catalog</h3><p class="${CA.error ? "bad" : "muted"}">${CA.error ? `Couldn't load the catalog settings: ${esc(CA.error)}` : "Loading…"}</p></section>`;
    return `<div id="caRoot">${settingsHtml()}${productsHtml()}</div>`;
  };
  const paint = () => { const root = $("caRoot"); if (root) root.innerHTML = settingsHtml() + productsHtml(); };
  const paintProducts = () => { const root = $("caRoot"); if (root) root.querySelectorAll("section")[1].outerHTML = productsHtml(); };
  const paintTable = () => { const t = $("caTable"); if (t) t.outerHTML = tableHtml(); const c = $("caCounts"); if (c) c.innerHTML = countsHtml(); };

  function settingsHtml() {
    const d = CA.draft, x = CA.data, s = cur(), link = origin + s.url;
    const tabs = `<div class="ca-tabs">${Object.entries(x.catalogs).map(([id, c]) => `<button type="button" data-ca-cat="${id}" class="${id === CA.cur ? "active" : ""}">${esc(c.name)}<small>${c.enabled ? (c.showPrices || c.showCasePrices ? "with prices" : "no prices") : "off"}${CA.per[id]?.dirty ? " · unsaved" : ""}</small></button>`).join("")}<button type="button" class="ca-add" data-ca-do="add" title="Add a catalog with its own link and password">+ Add catalog</button></div>`;
    const pw = s.password === "dashboard" ? "Set here in the dashboard." : s.password === "render" ? `Set on Render (${esc(s.passwordEnv)}).` : "Not set yet: customers can't open this catalog until you set one.";
    const warn = [
      !x.persistent && `<p class="warn">These settings are saved on the server's own disk and reset when it restarts. Set COMPETITOR_DATA_DIR to the Render disk (/var/data) to keep them.</p>`].filter(Boolean).join("");
    return `<section class="card">${tabs}
      <div class="head"><div><h3>${esc(s.name)} <span class="pill ${s.enabled ? "good" : "bad"}">${s.enabled ? "On" : "Off"}</span></h3>
        <p class="hint">Customers with this link see it: <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>. They sign in with this catalog's own password, never the admin token. The PDF and Excel downloads follow the same settings.</p></div>
        <div class="row"><button type="button" data-ca-do="copyLink">Copy link</button><a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">Open catalog ↗</a>
          ${Object.keys(x.catalogs).length > 1 ? `<button type="button" class="ca-remove" data-ca-do="remove">Remove catalog</button>` : ""}</div></div>
      ${warn}
      <div class="ca-grid">
        <div class="ca-box"><h4>Visibility</h4>
          <label class="ca-rule stack"><span>Name <small class="muted">(only you see it)</small></span><input type="text" id="caName" maxlength="40" placeholder="Catalog ${esc(s.id)}" value="${esc(d.name || "")}"></label>
          <label class="ca-toggle"><input type="checkbox" data-ca="enabled" ${d.enabled ? "checked" : ""}><span><b>Catalog is on</b><small>Turned off, customers see "The catalog is unavailable right now".</small></span></label>
          <label class="ca-toggle"><input type="checkbox" data-ca="showPrices" ${d.showPrices ? "checked" : ""}><span><b>Show piece prices</b><small>Wholesale cost + the piece markup, or the price you set for a SKU below.</small></span></label>
          <label class="ca-toggle"><input type="checkbox" data-ca="showCasePrices" ${d.showCasePrices ? "checked" : ""}><span><b>Show case prices</b><small>Per-piece price when buying by the case: wholesale cost + the case markup.</small></span></label>
        </div>
        <div class="ca-box"><h4>Wholesale pricing rules</h4>
          <label class="ca-rule">Piece price: wholesale cost +<span class="ca-field"><input type="number" step="0.1" min="-100" max="1000" data-ca-pct="pieceMarkupPct" value="${d.pieceMarkupPct}"><span>%</span></span></label>
          <label class="ca-rule">Case price, per piece: cost +<span class="ca-field"><input type="number" step="0.1" min="-100" max="1000" data-ca-pct="caseMarkupPct" value="${d.caseMarkupPct}"><span>%</span></span></label>
          <div class="ca-rule stack"><span>Round prices up to</span><div class="seg">${ROUNDING.map(([v, l]) => `<button type="button" data-ca-round="${v}" class="${+d.roundTo === v ? "active" : ""}">${l}</button>`).join("")}</div></div>
        </div>
        <div class="ca-box"><h4>Which products</h4>
          <label class="ca-choice"><input type="radio" name="caMode" data-ca="mode" value="all" ${d.mode === "all" ? "checked" : ""}><span>Every product in the API, except the ones you remove<small>New API products appear on their own.</small></span></label>
          <label class="ca-choice"><input type="radio" name="caMode" data-ca="mode" value="selected" ${d.mode === "selected" ? "checked" : ""}><span>Only the products you tick below<small>New API products stay out until you add them.</small></span></label>
        </div>
        <div class="ca-box"><h4>Password</h4>
          <div class="ca-pw"><span class="${s.password ? "muted" : "bad"}">${pw}</span>
            <input type="password" id="caPw" autocomplete="new-password" placeholder="New password (6+ characters)" value="${esc(CA.newPassword || "")}"></div>
          <p class="hint" style="margin:8px 0 0">Saved with the other changes. Changing it signs out everyone using this catalog.</p>
        </div>
      </div>
      <div class="ca-save">
        <button class="primary" data-ca-do="save" ${CA.dirty && !CA.saving ? "" : "disabled"}>${CA.saving ? "Saving…" : "Save changes"}</button>
        <button data-ca-do="discard" ${CA.dirty && !CA.saving ? "" : "disabled"}>Discard</button>
        <span class="${/^Couldn't|isn't/.test(CA.msg) ? "bad" : "muted"}" id="caMsg">${esc(CA.msg || (CA.dirty ? `Unsaved changes to ${s.name}. Customers see them after you save.` : s.updatedAt ? `Last saved ${when(s.updatedAt)}.` : `Using the default settings: every product, ${s.showPrices || s.showCasePrices ? "with prices" : "no prices"}.`))}</span>
      </div></section>`;
  }

  function countsHtml() {
    const items = CA.data.items, n = items.filter(i => isIn(i)).length, d = CA.draft;
    return `<b>${n.toLocaleString()}</b> of ${items.length.toLocaleString()} API products in the catalog · ${d.hidden.length.toLocaleString()} removed by you · ${d.added.length.toLocaleString()} added by you · ${Object.keys(d.prices).length.toLocaleString()} with your own price`;
  }
  const FILTERS = { all: "All products", in: "In the catalog", out: "Not in the catalog", removed: "Removed by you", added: "Added by you", priced: "With your own price", internal: "Left out on their own (opened, deleted, discontinued)" };
  function shown() {
    const q = CA.q.trim().toLowerCase(), d = CA.draft;
    const test = { all: () => true, in: i => isIn(i), out: i => !isIn(i), removed: i => d.hidden.includes(i.sku), added: i => d.added.includes(i.sku), priced: i => i.sku in d.prices, internal: i => !i.auto }[CA.filter];
    return CA.data.items.filter(i => test(i) && (!q || `${i.sku} ${i.name} ${i.upc} ${i.category}`.toLowerCase().includes(q)));
  }
  function productsHtml() {
    return `<section class="card"><div class="head"><div><h3>Products</h3><p class="hint" id="caCounts">${countsHtml()}</p></div></div>
      <div class="ca-bar"><input type="search" class="search" id="caQ" placeholder="Search SKU, name or UPC" value="${esc(CA.q)}">
        ${ui.selectTrigger("caF", "Show", esc(FILTERS[CA.filter]), CA.filter !== "all")}
        <button type="button" data-ca-do="inAll">Add all shown</button><button type="button" data-ca-do="outAll">Remove all shown</button></div>
      ${tableHtml()}</section>`;
  }
  function tableHtml() {
    const list = shown(), d = CA.draft;
    const rows = list.slice(0, CA.limit).map(i => {
      const on = isIn(i), p = price(i), own = i.sku in d.prices;
      return `<tr class="${on ? "" : "off"}">
        <td><input type="checkbox" data-ca-sku="${esc(i.sku)}" ${on ? "checked" : ""} title="In the catalog"></td>
        <td class=l>${esc(i.sku)}${!i.auto ? ' <span class="pill muted" title="Opened box, deleted or discontinued: left out unless you add it">internal</span>' : ""}</td>
        <td class=l>${esc(i.name)}</td><td class=l>${esc(i.category)}</td>
        <td>${usd(i.cost)}</td><td>${usd(rulePiece(i))}</td>
        <td><input type="number" min="0" step="0.01" data-ca-price="${esc(i.sku)}" value="${own ? d.prices[i.sku] : ""}" placeholder="${rulePiece(i) ?? ""}" title="Leave empty to use the rule"></td>
        <td>${i.qty ?? "<span class=muted>—</span>"}</td><td>${usd(caseUnit(i))}</td></tr>`;
    }).join("");
    return `<div class="tablewrap" id="caTable"><table><thead><tr><th>In</th><th class=l>SKU</th><th class=l>Name</th><th class=l>Category</th><th>Wholesale cost</th><th>Piece (rule)</th><th>Your piece price</th><th>Qty / case</th><th>Case price (per piece)</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="10" class="muted" style="text-align:center;padding:20px">No products match.</td></tr>`}</tbody></table>
      ${list.length > CA.limit ? `<p class="muted" style="margin:8px">Showing ${CA.limit.toLocaleString()} of ${list.length.toLocaleString()}. <a href="#" data-ca-do="more">Show all</a> or search to narrow it down.</p>` : ""}</div>`;
  }

  function changed(msg = "") { CA.dirty = true; CA.msg = msg; }
  function setIn(i, on) {
    const d = CA.draft, rm = (k, v) => { d[k] = d[k].filter(x => x !== v); }, add = (k, v) => { if (!d[k].includes(v)) d[k].push(v); };
    if (on) { rm("hidden", i.sku); if (!(d.mode === "all" && i.auto)) add("added", i.sku); }
    else { rm("added", i.sku); if (d.mode === "all" && i.auto) add("hidden", i.sku); }
  }

  document.addEventListener("change", e => {
    if (!$("caRoot") || !$("caRoot").contains(e.target)) return;
    const t = e.target, d = CA.draft;
    if (t.dataset.ca === "mode") {
      // Switching to "only the SKUs you add" starts from what's in the catalog now, so nothing disappears by surprise.
      if (t.value === "selected" && d.mode === "all") { const now = CA.data.items.filter(i => isIn(i)).map(i => i.sku); d.mode = "selected"; d.added = now; d.hidden = []; }
      else d.mode = t.value;
      changed(); paint(); return;
    }
    if (t.dataset.ca) { d[t.dataset.ca] = t.checked; changed(); paint(); return; }
    if (t.dataset.caPct) { const n = Number(t.value); if (t.value.trim() === "" || !Number.isFinite(n)) return; d[t.dataset.caPct] = n; changed(); paintTable(); paintSave(); return; }
    if (t.dataset.caSku) { setIn(bySku().get(t.dataset.caSku), t.checked); changed(); paintTable(); paintSave(); return; }
    if (t.dataset.caPrice != null) {
      const sku = t.dataset.caPrice, v = t.value.trim(), n = Number(v);
      if (v === "") delete d.prices[sku]; else if (Number.isFinite(n) && n >= 0) d.prices[sku] = Math.round(n * 100) / 100; else return;
      changed(); paintTable(); paintSave(); return;
    }
  });
  let qt;
  document.addEventListener("input", e => {
    // Typing the name or a password enables Save without redrawing, so the field keeps focus.
    if (e.target.id === "caName") { CA.draft.name = e.target.value; if (!CA.dirty) { CA.dirty = true; CA.msg = ""; const b = document.querySelector('[data-ca-do="save"]'); if (b) b.disabled = false; } return; }
    if (e.target.id === "caPw") { CA.newPassword = e.target.value; if (e.target.value.trim() && !CA.dirty) { CA.dirty = true; CA.msg = ""; const b = document.querySelector('[data-ca-do="save"]'); if (b) b.disabled = false; } return; }
    if (e.target.id !== "caQ") return; CA.q = e.target.value; CA.limit = 300; clearTimeout(qt); qt = setTimeout(paintTable, 150); });
  const paintSave = () => { const root = $("caRoot"); if (!root) return; const tmp = document.createElement("div"); tmp.innerHTML = settingsHtml(); root.querySelector("section").replaceWith(tmp.firstElementChild); };

  document.addEventListener("click", async e => {
    const rb = e.target.closest("[data-ca-round]");
    if (rb && $("caRoot")?.contains(rb)) { CA.draft.roundTo = Number(rb.dataset.caRound); changed(); paintTable(); paintSave(); return; }
    const fb = e.target.closest("#caF");
    if (fb) { ui.selectMenu(fb, Object.entries(FILTERS).map(([k, v]) => ({ value: k, label: v })), CA.filter, v => { CA.filter = v; CA.limit = 300; paintProducts(); }); return; }
    const tab = e.target.closest("[data-ca-cat]");
    if (tab && $("caRoot")?.contains(tab)) { CA.cur = tab.dataset.caCat; paint(); return; }
    const b = e.target.closest("[data-ca-do]"); if (!b || !$("caRoot")?.contains(b)) return;
    e.preventDefault();
    const act = b.dataset.caDo;
    if (act === "copyLink") { navigator.clipboard?.writeText(origin + cur().url).then(() => { CA.msg = "Link copied."; paintSave(); }, () => {}); return; }
    if (act === "more") { CA.limit = Infinity; paintTable(); return; }
    if (act === "inAll" || act === "outAll") { for (const i of shown()) setIn(i, act === "inAll"); changed(); paintTable(); paintSave(); return; }
    if (act === "add") {
      try {
        const r = await fetch("/api/catalog/add", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        CA.data.catalogs[out.settings.id] = out.settings; CA.per[out.settings.id] = { draft: copy(out.settings) };
        CA.cur = out.settings.id; CA.msg = `${out.settings.name} added. Set a password so customers can open it.`;
        shell.loadCatalogs();
      } catch (err) { CA.msg = `Couldn't add a catalog: ${err.message}`; }
      paint(); return;
    }
    if (act === "remove") {
      const c = cur();
      if (!confirm(`Remove ${c.name}? Its link (${c.url}) stops working and its settings, prices and password are deleted. This can't be undone.`)) return;
      try {
        const r = await fetch("/api/catalog/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ catalog: c.id }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        delete CA.data.catalogs[c.id]; delete CA.per[c.id];
        CA.cur = Object.keys(CA.data.catalogs)[0]; CA.msg = `${c.name} removed.`;
        shell.loadCatalogs();
      } catch (err) { CA.msg = `Couldn't remove it: ${err.message}`; }
      paint(); return;
    }
    if (act === "discard") { CA.draft = copy(cur()); CA.dirty = false; CA.msg = ""; CA.newPassword = ""; paint(); return; }
    if (act === "save") {
      CA.saving = true; paintSave();
      try {
        const send = () => fetch("/api/catalog/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...CA.draft, catalog: CA.cur, newPassword: CA.newPassword || "" }) });
        // 502/503 come from Render while the server restarts (a deploy); wait a moment and try once more.
        let r = await send();
        if (r.status === 502 || r.status === 503) { CA.msg = "The server is restarting, trying again…"; paintSave(); await new Promise(ok => setTimeout(ok, 8000)); r = await send(); }
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        CA.data.catalogs[CA.cur] = out.settings; CA.draft = copy(out.settings); CA.dirty = false; CA.newPassword = "";
        shell.loadCatalogs();   // the name may have changed
        CA.msg = `Saved ${when(out.settings.updatedAt)}. Customers with ${out.settings.name} open see the changes within a minute.`;
      } catch (err) { CA.msg = `Couldn't save: ${err.message}`; }
      CA.saving = false; paint();
    }
  });
})();
