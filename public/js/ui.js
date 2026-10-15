// Shared interface pieces, styled by ads.css:
//   ui.menu   a dropdown panel under a trigger button (single choice like a select, or checkboxes that stay open)
//   ui.select builds a select trigger and opens its menu (used for Platform, Category and Tier in the top bar)
//   ui.pager  the pagination row under a table
(() => {
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---- Dropdown menu ----
  // One panel is shared by every dropdown on the page. open(trigger, { html, onPick }):
  //   html()   returns the panel's contents; clickable rows carry data-pick="value"
  //   onPick   runs with (value, element); return true to keep the panel open (it redraws), otherwise it closes.
  // The trigger is found again by id after the page redraws, so it must have an id.
  const panel = document.createElement("div");
  panel.className = "dd-menu"; panel.hidden = true; panel.setAttribute("role", "menu");
  let cur = null;   // { id, html, onPick } of the open menu
  const trigger = () => cur && document.getElementById(cur.id);
  function place() {
    const t = trigger(); if (!t) return close();
    const r = t.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const below = r.bottom + 4, top = below + h > innerHeight - 8 && r.top - h - 4 > 8 ? r.top - h - 4 : below;
    panel.style.left = left + "px"; panel.style.top = top + "px";
  }
  function draw() { panel.innerHTML = cur.html(); place(); }
  function open(t, opts) {
    if (!t.id) throw new Error("ui.menu trigger needs an id");
    if (cur?.id === t.id && !panel.hidden) return close();
    close();
    cur = { id: t.id, ...opts };
    if (!panel.isConnected) document.body.append(panel);
    panel.hidden = false; t.setAttribute("aria-expanded", "true");
    draw();
    panel.querySelector(".sel, [data-pick]")?.focus({ preventScroll: true });
  }
  function close() {
    if (!cur) return;
    trigger()?.setAttribute("aria-expanded", "false");
    panel.hidden = true; cur = null;
  }
  panel.addEventListener("click", e => {
    const el = e.target.closest("[data-pick]"); if (!el || !cur) return;
    e.preventDefault();
    const keep = cur.onPick(el.dataset.pick, el);
    if (keep && cur) draw(); else close();
  });
  // Keyboard: arrows move between rows, Escape closes and returns focus to the trigger.
  panel.addEventListener("keydown", e => {
    const items = [...panel.querySelectorAll("[data-pick]")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && cur) { const t = trigger(); close(); t?.focus(); } });
  document.addEventListener("mousedown", e => { if (cur && !panel.contains(e.target) && !e.target.closest(`#${CSS.escape(cur.id)}`)) close(); }, true);
  addEventListener("resize", () => cur && place());
  addEventListener("scroll", e => { if (cur && !panel.contains(e.target)) place(); }, true);
  // Called after a page redraw so an open menu follows its (new) trigger, or closes if it's gone.
  const refresh = () => { if (cur) { if (trigger()) { trigger().setAttribute("aria-expanded", "true"); draw(); } else close(); } };

  // ---- Select ----
  // Trigger markup for a select: "Label  Value ▾". active marks a non-default choice.
  const selectTrigger = (id, label, valueHtml, active) =>
    `<button type="button" class="dd-trigger${active ? " on" : ""}" id="${id}" aria-haspopup="menu" aria-expanded="false"><span class="lbl">${esc(label)}</span><span class="val">${valueHtml}</span></button>`;
  // options: [{ value, label, icon?, meta? }]; picks call onChange(value).
  function selectMenu(t, options, value, onChange) {
    open(t, {
      html: () => options.map(o => `<button type="button" class="dd-item${String(o.value) === String(value) ? " sel" : ""}" data-pick="${esc(o.value)}" role="menuitemradio" aria-checked="${String(o.value) === String(value)}">
        ${o.icon || ""}<span class="nm">${esc(o.label)}</span>${o.meta != null ? `<span class="mt">${esc(o.meta)}</span>` : ""}</button>`).join(""),
      onPick: v => { onChange(v); return false; },
    });
  }

  // ---- Pagination ----
  // Page buttons with gaps (1 … 4 5 6 … 20) and a rows-per-page select. Buttons carry data-page / data-size for the page script.
  function pager(id, page, pages, total, size, sizes = [25, 50, 100, 250]) {
    if (total <= Math.min(...sizes)) return "";
    const nums = [...new Set([1, page - 1, page, page + 1, pages].filter(n => n >= 1 && n <= pages))].sort((a, b) => a - b);
    const btns = []; nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) btns.push(`<span>…</span>`); btns.push(`<button type="button" data-tbl="${id}" data-page="${n}" class="${n === page ? "active" : ""}">${n}</button>`); });
    const from = (page - 1) * size + 1, to = Math.min(total, page * size);
    return `<div class="pager"><span>${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}</span>
      <div class="pages"><button type="button" data-tbl="${id}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="Previous page">‹</button>${btns.join("")}<button type="button" data-tbl="${id}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""} aria-label="Next page">›</button></div>
      <label>Rows <select data-tbl="${id}" data-size>${sizes.map(n => `<option ${n === size ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>`;
  }

  window.ui = { esc, menu: { open, close, refresh }, selectTrigger, selectMenu, pager };
})();
