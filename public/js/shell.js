// App shell for the signed-in pages: the top bar and the side navigation.
//
// Load this file in <head> (it applies the saved light/dark theme before the page paints), then call
// shell.mount() at the end of <body>. <body data-page="…"> says which page this is:
//   "reports"        the reports page (public/index.html). It gets the filter slot (#topFilters) and the
//                    search slot (#topSearch) in the top bar, and switches views itself on /#view links.
//   "catalog-admin"  Catalog management. No filters; its side nav item is highlighted.
(() => {
  // ---- Theme: "light", "dark" or "system" (follow the device). Saved in this browser. ----
  const THEME_KEY = "asi-theme";
  const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } };
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(getTheme());

  // ---- Icons: 24px line icons drawn inline so they follow the text color. ----
  const i = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    overview: i('<path d="M4 11.5 12 5l8 6.5"/><path d="M6 10v9h4.5v-5h3v5H18v-9"/>'),
    sold: i('<path d="M5 19V9"/><path d="M10 19V5"/><path d="M15 19v-7"/><path d="M20 19v-11"/><path d="M3 19h18"/>'),
    reorder: i('<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7"/><path d="M20 4v4.7h-4.7"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.3"/><path d="M4 20v-4.7h4.7"/>'),
    pl: i('<path d="M12 3v18"/><path d="M16.5 7.5C16 6 14.3 5 12 5c-2.8 0-4.5 1.3-4.5 3.2 0 4.4 9 2.4 9 7 0 2-1.8 3.3-4.5 3.3-2.4 0-4.2-1-4.8-2.7"/>'),
    master: i('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15"/>'),
    vendors: i('<path d="M3 9h11v8H3z"/><path d="M14 12h4l3 3v2h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>'),
    competitors: i('<path d="M4 15.5 9 10l4 4 7-8"/><path d="M15 6h5v5"/>'),
    insights: i('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>'),
    catalogAdmin: i('<path d="M4 5.5h6a2 2 0 0 1 2 2V20a2 2 0 0 0-2-2H4z"/><path d="M20 5.5h-6a2 2 0 0 0-2 2V20a2 2 0 0 1 2-2h6z"/>'),
    catalog: i('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 9v11"/>'),
    ext: i('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    menu: i('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    refresh: i('<path d="M20 12a8 8 0 1 1-2.3-5.6L20 8.7"/><path d="M20 4v4.7h-4.7"/>'),
    signout: i('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>'),
    light: i('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: i('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
    system: i('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
  };

  // ---- Navigation. Report views are /#key on the reports page; keep this order in sync with the README. ----
  const VIEWS = [
    ["overview", "Overview"], ["sold", "Items sold"], ["reorder", "Reorder"], ["pl", "Profit & Loss"],
    ["master", "Product master"], ["vendors", "Vendors"], ["competitors", "TikTok competitors"], ["insights", "Insights"],
  ];
  // Old links (bookmarks from before the rename) still land on the right view.
  const OLD_VIEWS = { sheet: "master", actions: "insights" };
  const BRANDS = [["lattafa", "Lattafa"], ["armaf", "Armaf"], ["arabiyat", "Arabiyat"], ["afnan", "Afnan"], ["maison-alhambra", "Maison Alhambra"],
    ["rasasi", "Rasasi"], ["giorgio-armani", "Giorgio Armani"], ["bharara", "Bharara", "png"], ["paris-corner", "Paris Corner"], ["fragrance-world", "Fragrance World"]];
  const THEMES = [["light", "Light"], ["dark", "Dark"], ["system", "Match device"]];

  function mount() {
    const page = document.body.dataset.page, reports = page === "reports";
    if (!reports) document.body.classList.add("no-filters");
    const top = document.createElement("header"); top.className = "topbar";
    top.innerHTML = `<button class="navtoggle" id="navToggle" aria-label="Menu">${ICON.menu}</button>
      <a class="home" href="/#overview" title="Reports home"><span class="plate"><img src="/media/logo-fwusa.jpg" alt="Fragrance Wholesaler USA"></span>
        <span class="appname"><b>Fragrance Wholesaler USA</b><span>Business dashboard</span></span></a>
      ${reports ? `<div class="mid" id="topFilters"></div><div class="searchslot" id="topSearch"></div>` : `<span style="flex:1"></span>`}
      <div class="actions">
        ${reports ? `<button class="subtle" id="reload" title="Load the latest products from the API">${ICON.refresh}<span class="lbl">Refresh</span></button>` : ""}
        <button class="subtle" id="themeBtn" aria-haspopup="menu" title="Light or dark">${ICON[getTheme()]}</button>
        <a class="btn subtle" href="/logout" title="Sign out">${ICON.signout}<span class="lbl">Sign out</span></a></div>`;
    const nav = document.createElement("nav"); nav.className = "sidenav"; nav.setAttribute("aria-label", "Main");
    nav.innerHTML = `<h2>Reports</h2>${VIEWS.map(([k, label]) => `<a href="/#${k}" data-view="${k}">${ICON[k]}<span>${label}</span></a>`).join("")}
      <h2>Catalog</h2>
      <a href="/catalog-admin.html" data-view="catalog-admin">${ICON.catalogAdmin}<span>Catalog management</span></a>
      <a href="/catalog" target="_blank" rel="noopener">${ICON.catalog}<span>Catalog 1</span>${ICON.ext.replace("<svg", '<svg class="ext"')}</a>
      <a href="/catalog2" target="_blank" rel="noopener">${ICON.catalog}<span>Catalog 2</span>${ICON.ext.replace("<svg", '<svg class="ext"')}</a>
      <div class="brands" aria-label="Our brands">${BRANDS.map(([k, n, ext]) => `<span class="plate" title="${n}"><img src="/media/brand-${k}.${ext || "jpg"}" alt="${n}" loading="lazy"></span>`).join("")}</div>
      <div class="foot" id="navFoot"></div>`;
    const scrim = document.createElement("div"); scrim.className = "navscrim";
    document.body.prepend(top, nav, scrim);

    // Phone: the menu button slides the side nav in; tapping outside or a link closes it.
    const closeNav = () => document.body.classList.remove("nav-open");
    top.querySelector("#navToggle").onclick = () => document.body.classList.toggle("nav-open");
    scrim.onclick = closeNav;
    nav.addEventListener("click", e => { if (e.target.closest("a")) closeNav(); });

    // Theme switch: a small menu (ui.js) with Light, Dark and Match device.
    const themeBtn = top.querySelector("#themeBtn");
    themeBtn.onclick = () => ui.selectMenu(themeBtn, THEMES.map(([v, l]) => ({ value: v, label: l, icon: ICON[v] })), getTheme(), v => {
      try { localStorage.setItem(THEME_KEY, v); } catch {}
      applyTheme(v); themeBtn.innerHTML = ICON[v];
      document.dispatchEvent(new CustomEvent("themechange"));   // charts redraw in the new colors
    });
    if (!reports) setActive(page);
  }

  // Highlight the side nav item of the current view.
  function setActive(view) {
    document.querySelectorAll(".sidenav a[data-view]").forEach(a => {
      const on = a.dataset.view === view; a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }
  window.shell = { mount, setActive, VIEWS: Object.fromEntries(VIEWS), OLD_VIEWS, ICON };
})();
