// "Customer catalog" tab: the owner turns the customer catalog (/catalog) on or off, chooses whether
// piece and case prices show, and picks which SKUs are in it, with optional per-SKU prices. Settings
// are saved through /api/catalog/settings (catalog.js); the catalog and its PDF/Excel downloads follow
// them within a minute. Uses $, esc, fmtUsd, ST and render from index.html.
(() => {
  const css = document.createElement("style");
  css.textContent = `
    .ca-opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px 24px; margin: 6px 0 12px; }
    .ca-opts label { display: flex; gap: 8px; align-items: flex-start; }
    .ca-opts label small { display: block; color: var(--muted); font-size: 12px; }
    .ca-opts fieldset { border: 0; padding: 0; margin: 0; } .ca-opts legend { font-weight: 600; margin-bottom: 4px; padding: 0; }
    .ca-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .ca-bar input[type=search] { flex: 1 1 220px; max-width: 360px; }
    .ca-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .ca-add input { flex: 1 1 260px; max-width: 520px; }
    #caTable td:nth-child(2) { max-width: 190px; white-space: normal; overflow-wrap: break-word; }
    #caTable td:nth-child(3) { min-width: 320px; white-space: normal; }
    #caTable td input[type=number] { width: 92px; text-align: right; }
    #caTable tr.off td { color: var(--muted); }
    #caTable tr.off td:nth-child(3) { text-decoration: line-through; }
    .ca-save { position: sticky; bottom: 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 0 2px; background: var(--panel); }
    .ca-save button.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
    .ca-save button:disabled { opacity: .5; cursor: default; }`;
  document.head.appendChild(css);

  const CA = { data: null, draft: null, loading: false, error: "", q: "", filter: "all", msg: "", dirty: false, saving: false, limit: 300 };
  const copy = s => JSON.parse(JSON.stringify(s));
  const bySku = () => CA.index || (CA.index = new Map(CA.data.items.map(i => [i.sku, i])));
  const isIn = (i, s = CA.draft) => !s.hidden.includes(i.sku) && (s.added.includes(i.sku) || (s.mode === "all" && i.auto));
  const price = i => CA.draft.prices[i.sku] ?? i.piece;
  const usd = v => v == null ? "<span class=muted>Contact Sales</span>" : fmtUsd(v);
  const when = t => t ? new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";

  async function load() {
    CA.loading = true; CA.error = "";
    try {
      const r = await fetch("/api/catalog/settings", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      CA.data = d; CA.index = null;
      if (!CA.dirty) CA.draft = copy(d.settings);
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
  const paintTable = () => { const t = $("caTable"); if (t) t.outerHTML = tableHtml(); const c = $("caCounts"); if (c) c.innerHTML = countsHtml(); };

  function settingsHtml() {
    const d = CA.draft, x = CA.data, s = x.settings;
    const warn = [!x.passwordSet && `<p class="bad">CATALOG_PASSWORD isn't set on Render, so customers can't open the catalog yet.</p>`,
      !x.persistent && `<p class="warn">These settings are saved on the server's own disk and reset when it restarts. Set COMPETITOR_DATA_DIR to the Render disk (/var/data) to keep them.</p>`].filter(Boolean).join("");
    return `<section class="card">
      <div class="head"><div><h3>Customer catalog <span class="pill ${s.enabled ? "good" : "bad"}">${s.enabled ? "On" : "Off"}</span></h3>
        <p class="hint" style="margin:0">What customers see at <a href="/catalog" target="_blank" rel="noopener">/catalog</a> and in its PDF and Excel downloads. Customers sign in with the catalog password, not the admin token.</p></div>
        <a href="/catalog" target="_blank" rel="noopener"><button type="button">Open catalog ↗</button></a></div>
      ${warn}
      <div class="ca-opts">
        <label><input type="checkbox" data-ca="enabled" ${d.enabled ? "checked" : ""}><span><b>Catalog is on</b><small>Turned off, customers see "The catalog is unavailable right now".</small></span></label>
        <label><input type="checkbox" data-ca="showPrices" ${d.showPrices ? "checked" : ""}><span><b>Show piece prices</b><small>Wholesale cost from the API, or the price you set for a SKU below.</small></span></label>
        <label><input type="checkbox" data-ca="showCasePrices" ${d.showCasePrices ? "checked" : ""}><span><b>Show case prices</b><small>Piece price × qty in case.</small></span></label>
        <fieldset><legend>Which products</legend>
          <label><input type="radio" name="caMode" data-ca="mode" value="all" ${d.mode === "all" ? "checked" : ""}><span>Every product in the API, except the ones you remove<small>New API products appear on their own.</small></span></label>
          <label><input type="radio" name="caMode" data-ca="mode" value="selected" ${d.mode === "selected" ? "checked" : ""}><span>Only the SKUs you add<small>New API products stay out until you add them.</small></span></label>
        </fieldset>
      </div>
      <div class="ca-add"><input id="caAddSkus" placeholder="Add SKUs, separated by commas or spaces (e.g. PER423, PER770)"><button type="button" data-ca-do="add">Add to catalog</button><button type="button" data-ca-do="remove">Remove from catalog</button></div>
      <div class="ca-save">
        <button class="primary" data-ca-do="save" ${CA.dirty && !CA.saving ? "" : "disabled"}>${CA.saving ? "Saving…" : "Save changes"}</button>
        <button data-ca-do="discard" ${CA.dirty && !CA.saving ? "" : "disabled"}>Discard</button>
        <span class="${/^Couldn't|isn't/.test(CA.msg) ? "bad" : "muted"}" id="caMsg">${esc(CA.msg || (CA.dirty ? "Unsaved changes. Customers see them after you save." : s.updatedAt ? `Last saved ${when(s.updatedAt)}.` : "Using the default settings: every product, with both prices."))}</span>
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
    return `<section class="card"><div class="head"><div><h3>Products</h3><p class="hint" style="margin:0" id="caCounts">${countsHtml()}</p></div></div>
      <div class="ca-bar"><input type="search" id="caQ" placeholder="Search SKU, name or UPC" value="${esc(CA.q)}">
        <select id="caF">${Object.entries(FILTERS).map(([k, v]) => `<option value="${k}" ${CA.filter === k ? "selected" : ""}>${v}</option>`).join("")}</select>
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
        <td>${usd(i.piece)}</td>
        <td><input type="number" min="0" step="0.01" data-ca-price="${esc(i.sku)}" value="${own ? d.prices[i.sku] : ""}" placeholder="${i.piece ?? ""}" title="Leave empty to use the API price"></td>
        <td>${i.qty ?? "<span class=muted>—</span>"}</td><td>${usd(p != null && i.qty ? Math.round(p * i.qty * 100) / 100 : null)}</td></tr>`;
    }).join("");
    return `<div class="tablewrap" id="caTable"><table><thead><tr><th>In</th><th class=l>SKU</th><th class=l>Name</th><th class=l>Category</th><th>API price</th><th>Your price</th><th>Qty / case</th><th>Case price</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">No products match.</td></tr>`}</tbody></table>
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
    if (t.dataset.caSku) { setIn(bySku().get(t.dataset.caSku), t.checked); changed(); paintTable(); paintSave(); return; }
    if (t.dataset.caPrice != null) {
      const sku = t.dataset.caPrice, v = t.value.trim(), n = Number(v);
      if (v === "") delete d.prices[sku]; else if (Number.isFinite(n) && n >= 0) d.prices[sku] = Math.round(n * 100) / 100; else return;
      changed(); paintTable(); paintSave(); return;
    }
    if (t.id === "caF") { CA.filter = t.value; CA.limit = 300; paintTable(); }
  });
  let qt;
  document.addEventListener("input", e => { if (e.target.id !== "caQ") return; CA.q = e.target.value; CA.limit = 300; clearTimeout(qt); qt = setTimeout(paintTable, 150); });
  const paintSave = () => { const root = $("caRoot"); if (!root) return; const tmp = document.createElement("div"); tmp.innerHTML = settingsHtml(); root.querySelector("section").replaceWith(tmp.firstElementChild); };

  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-ca-do]"); if (!b || !$("caRoot")?.contains(b)) return;
    e.preventDefault();
    const act = b.dataset.caDo;
    if (act === "more") { CA.limit = Infinity; paintTable(); return; }
    if (act === "inAll" || act === "outAll") { for (const i of shown()) setIn(i, act === "inAll"); changed(); paintTable(); paintSave(); return; }
    if (act === "add" || act === "remove") {
      const want = $("caAddSkus").value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean), map = bySku();
      // Match SKUs the way the sheet does: ignore case and spaces.
      const norm = s => s.replace(/\s+/g, "").toUpperCase(), byNorm = new Map(CA.data.items.map(i => [norm(i.sku), i]));
      const found = [], missing = [];
      for (const w of want) { const i = map.get(w) || byNorm.get(norm(w)); i ? found.push(i) : missing.push(w); }
      found.forEach(i => setIn(i, act === "add"));
      if (found.length) $("caAddSkus").value = missing.join(", ");
      const msg = `${found.length} SKU${found.length === 1 ? "" : "s"} ${act === "add" ? "added" : "removed"}${missing.length ? `; not in the API: ${missing.join(", ")}` : ""}.`;
      if (found.length) changed(msg + " Save to publish."); else CA.msg = msg;
      paint(); return;
    }
    if (act === "discard") { CA.draft = copy(CA.data.settings); CA.dirty = false; CA.msg = ""; paint(); return; }
    if (act === "save") {
      CA.saving = true; paintSave();
      try {
        const r = await fetch("/api/catalog/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...CA.draft, editor: "dashboard" }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        CA.data.settings = out.settings; CA.draft = copy(out.settings); CA.dirty = false;
        CA.msg = `Saved ${when(out.settings.updatedAt)}. Open catalogs update within a minute.`;
      } catch (err) { CA.msg = `Couldn't save: ${err.message}`; }
      CA.saving = false; paint();
    }
  });
})();
