// "Excel sheet" section of the product detail: shows the SKU's row from the workbook and saves edits
// back to it through /api/excel (see excel.js). Uses $, esc and compPost from index.html.
(() => {
  const css = document.createElement("style");
  css.textContent = `
    .xl-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
    .xl-bar input[type=search] { flex: 1 1 180px; }
    .xl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
    .xl-grid label { display: block; background: var(--bg); border-radius: 8px; padding: 6px 9px; border: 1px solid transparent; }
    .xl-grid label span { display: flex; justify-content: space-between; gap: 6px; color: var(--muted); font-size: 11px; }
    .xl-grid input { width: 100%; box-sizing: border-box; margin-top: 3px; font: inherit; padding: 4px 6px;
      border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); }
    .xl-grid label.ro div { margin-top: 3px; padding: 4px 0; overflow-wrap: anywhere; }
    .xl-grid label.dirty { border-color: var(--accent); }
    .xl-grid label.err { border-color: var(--bad); }
    .xl-grid label.saved { border-color: var(--good); }
    .xl-grid label em { font-style: normal; color: var(--bad); font-size: 11px; display: block; margin-top: 2px; }`;
  document.head.appendChild(css);

  let info = null;
  const loadInfo = async () => { if (!info || !info.ok) info = await fetch("/api/excel").then(r => r.json()).catch(e => ({ error: e.message })); return info; };
  let state = null; // { sku, row, cells, showRo, q, errors }

  window.excelPanel = async r => {
    if (!location.protocol.startsWith("http")) return;
    const body = $("dBody"), box = document.createElement("div");
    box.id = "xlBox";
    box.innerHTML = `<h4>Excel sheet</h4><p class=muted>Loading the row from Excel…</p>`;
    body.appendChild(box);
    const i = await loadInfo();
    if (box !== $("xlBox")) return; // another product was opened meanwhile
    if (!i.configured) { box.innerHTML = `<h4>Excel sheet</h4><p class=muted>Editing the Excel sheet isn't connected yet (the server needs ${esc((i.missing || []).join(", "))}).</p>`; return; }
    if (!i.ok) { box.innerHTML = `<h4>Excel sheet</h4><p class=bad>Couldn't open the workbook: ${esc(i.error || "unknown error")}</p>`; return; }
    await loadRow(r.sku, box);
  };

  async function loadRow(sku, box) {
    const res = await fetch(`/api/excel/row?sku=${encodeURIComponent(sku)}`);
    const out = await res.json().catch(() => ({}));
    if (box !== $("xlBox")) return;
    if (!res.ok) { box.innerHTML = `<h4>Excel sheet</h4><p class=${res.status === 404 ? "muted" : "bad"}>${esc(out.error || `HTTP ${res.status}`)}</p>`; return; }
    state = { ...out, showRo: state?.showRo || false, q: state?.sku === sku ? state.q : "", errors: {}, saved: {} };
    draw(box);
  }

  function draw(box) {
    const s = state, q = s.q.trim().toUpperCase();
    const shown = s.cells.filter(c => (s.showRo || c.editable) && (!q || c.label.includes(q) || String(c.text).toUpperCase().includes(q)));
    const edits = s.cells.filter(c => c.editable).length;
    box.innerHTML = `<h4>Excel sheet <span class=muted>· ${esc(info.name || "")} · ${esc(s.sheet)} row ${s.row}</span></h4>
      <div class="xl-bar"><input type=search id=xlQ placeholder="Find a column" value="${esc(s.q)}">
        <label><input type=checkbox id=xlRo ${s.showRo ? "checked" : ""}> Show formula columns</label>
        <button id=xlSave disabled>Save to Excel</button>
        ${info.webUrl ? `<a href="${esc(info.webUrl)}" target=_blank rel=noopener>Open in Excel</a>` : ""}</div>
      <p class="hint muted" id=xlMsg>${info.canEdit ? `${edits} columns you can edit. Formula columns stay as they are in Excel.` : "Read only: set ADMIN_TOKEN on the server to turn on editing."}</p>
      <div class="xl-grid">${shown.map(c => {
        const tag = `<span>${esc(c.label)}<b>${c.col}</b></span>`;
        if (!c.editable || !info.canEdit) return `<label class=ro title="${esc(c.formula || c.reason)}">${tag}<div>${esc(c.text) || "<span class=muted>—</span>"}</div></label>`;
        const cls = s.errors[c.col] ? "err" : s.saved[c.col] ? "saved" : "";
        return `<label class="${cls}">${tag}<input data-xl="${c.col}" value="${esc(c.text)}">${s.errors[c.col] ? `<em>${esc(s.errors[c.col])}</em>` : ""}</label>`;
      }).join("") || `<p class=muted>No columns match.</p>`}</div>`;
    const qEl = box.querySelector("#xlQ");
    qEl.oninput = () => { s.q = qEl.value; const pos = qEl.selectionStart; keepInputs(box); draw(box); const n = box.querySelector("#xlQ"); n.focus(); n.setSelectionRange(pos, pos); };
    box.querySelector("#xlRo").onchange = e => { keepInputs(box); s.showRo = e.target.checked; draw(box); };
    box.querySelector("#xlSave").onclick = () => save(box);
    for (const inp of box.querySelectorAll("[data-xl]")) {
      const c = s.cells.find(x => x.col === inp.dataset.xl);
      if (c.draft != null) inp.value = c.draft;
      inp.oninput = () => { c.draft = inp.value; mark(box); };
      inp.onkeydown = e => { if (e.key === "Enter") save(box); };
    }
    mark(box);
  }
  const keepInputs = box => { for (const inp of box.querySelectorAll("[data-xl]")) state.cells.find(x => x.col === inp.dataset.xl).draft = inp.value; };
  const changed = () => state.cells.filter(c => c.draft != null && c.draft !== String(c.text ?? ""));
  function mark(box) {
    const n = changed();
    for (const inp of box.querySelectorAll("[data-xl]")) inp.closest("label").classList.toggle("dirty", n.some(c => c.col === inp.dataset.xl));
    const b = box.querySelector("#xlSave");
    b.disabled = !n.length; b.textContent = n.length ? `Save ${n.length} change${n.length > 1 ? "s" : ""} to Excel` : "Save to Excel";
  }

  async function save(box) {
    const n = changed();
    if (!n.length) return;
    let editor = ""; try { editor = localStorage.getItem("asi-editor") || ""; } catch {}
    if (!editor) { editor = (prompt("Your name, for the edit history:") || "").trim(); try { if (editor) localStorage.setItem("asi-editor", editor); } catch {} }
    const btn = box.querySelector("#xlSave"); btn.disabled = true; btn.textContent = "Saving…";
    const out = await compPost("/api/excel/edit", { sku: state.sku, editor, changes: n.map(c => ({ col: c.col, header: c.header, expected: c.value, value: c.draft })) });
    if (!out) { mark(box); return; }
    const errors = {}, saved = {};
    for (const x of out.results) (x.ok ? saved : errors)[x.col] = x.ok ? true : x.error;
    // Reload the row so formula columns show what Excel recalculated; keep failed drafts for a retry.
    const drafts = Object.fromEntries(n.filter(c => errors[c.col]).map(c => [c.col, c.draft]));
    await loadRow(state.sku, box);
    if (box !== $("xlBox")) return;
    for (const c of state.cells) if (drafts[c.col] != null) c.draft = drafts[c.col];
    state.errors = errors; state.saved = saved;
    draw(box);
    const ok = Object.keys(saved).length, bad = Object.keys(errors).length;
    box.querySelector("#xlMsg").innerHTML = `${ok ? `<span class=good>Saved ${ok} change${ok > 1 ? "s" : ""} to Excel.</span> ` : ""}${bad ? `<span class=bad>${bad} didn't save; see the red boxes.</span>` : ""}`;
  }
})();
