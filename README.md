# airseaimport

Single-page reports dashboard for the product data at
`https://hub.fragrancewholesalerusa.com/api/open/products`.

`npm start` (or `yarn start`) runs `server.js`, which serves `public/index.html` and proxies the API at `/api/products` (60s cache) so the browser never hits CORS. Once loaded, the last good product list stays in memory and is served right away while a fresh copy loads in the background, so pages never wait on a slow API. Nothing product-related is stored in the repo; everything comes from the live API. Deployed on Render as a Node web service.

Layout: `server.js` (entry point), `lib/` (server modules), `public/` (dashboard pages) with browser scripts in `public/js/`, `catalog/index.html` (customer catalog page), `media/` (all logos and the icon, served at `/media/`).

The page builds:

- KPI tiles: SKUs, units on hand, inventory value, 90-day sales, stockouts, low stock, dead stock, on order, return rate, September revenue/margin
- Charts: 60-day sales by channel, top 15 sellers, stock health (days of cover), cheapest-vendor wins
- Report tables (sortable, searchable, CSV export): Reorder, Top sellers, Vendor pricing, Dead stock, Channel mix, Returns, All products

A sticky filter bar picks the date field and range (default: today), category and tier. KPI tiles and chart bars open the matching report. Click any product for its full vendor price comparison. **Catalog management** in the top bar opens the catalog management page (`/catalog-admin.html`).

Data notes: on hand uses `live_qoh`; our cost is `actual_cost` when above 0, else `cost`; vendor columns (`lux`, `edge`, `tahir`, …) are supplier prices; `*_60_days` are 60-day sales projections per channel; `sales_sep_sale_price` and `sales_sep_shipping_price_we_paid` are September totals.

## TikTok competitors (Euka)

The **TikTok competitors** tab compares each SKU's TikTok price with up to 5 same-item TikTok Shop listings found through [Euka's OpenAPI](https://server.euka.ai/docs). Each SKU is searched in both `GET /social-intelligence/products` (current listed price, strike-through price, shipping) and `POST /market-intelligence/tiktok/product/rank` (also finds listings with no recent sales, plus commission and growth); kept matches get `product/detail` for their SKU price range, creators and reviews.

Setup: set `EUKA_API_KEY` in Render → Environment (all options are in `.env.example`). The server then checks every SKU in the products API on boot and every 12 hours (`lib/competitors.js`), and saves the results in `COMPETITOR_DATA_DIR`.

How matching works: each product name is cleaned (sizes and words like EDP, spray, for women are dropped) and searched in Euka. Then every result is scored by how many of our name's words its title contains. A different size caps the score below the match threshold, and decants, samples and sets are marked down. Our own listings (`tiktok_product_id`) are excluded. In a product's detail view you can hide a wrong match or pin the right listing, and that SKU re-checks right away.

The tab shows our price, the competitors' lowest, median and highest prices, the gap, competitor and our 30-day units, profit at the lowest price using the sheet's TikTok rule, a margin floor price, and a suggested price: a cent under the cheapest competitor, but never below the floor.

API: `GET /api/competitors` returns results, `GET /api/competitors/status` checks the key, `POST /api/competitors/refresh` (`{ "skus": [...] }` is optional) and `POST /api/competitors/override` (`{ sku, productId, action: "ignore" | "pin" | "clear" }`) need `x-admin-token` when `ADMIN_TOKEN` is set.

## Editing the Excel sheet

Each product's detail view has an **Excel sheet** section showing that SKU's row from the master tab of the workbook in OneDrive (`TIKTOK PRICING 786110.xlsx`, sheet `0. MASTER` by default). Type in any column and press **Save to Excel**; the server writes the cells through Microsoft Graph, the same as someone editing the file in Excel Online, so anything syncing from the live file picks the change up.

- Formula columns (everything looked up from Query1 or calculated) are shown read only and are never overwritten. Values starting with `=` are refused.
- A save checks each cell still holds what the page loaded; if someone changed it in Excel meanwhile, that field is rejected so their edit isn't lost.
- Saving asks for `ADMIN_TOKEN` and a name; every change is logged to `excel-edits.jsonl` in the data dir (`GET /api/excel/log`).

Setup: in the Microsoft Entra admin center, create an app registration, add the Microsoft Graph **application** permission `Files.ReadWrite.All`, grant admin consent, and create a client secret. Set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (and `ADMIN_TOKEN`) in Render → Environment. Other options are in `.env.example`.

API: `GET /api/excel` (connection status and columns), `GET /api/excel/row?sku=` (the SKU's row, with which cells are editable), `POST /api/excel/edit` (`{ sku, editor, changes: [{ col, header, expected, value }] }`, needs `x-admin-token`).

## Customer catalogs

There are two customer catalogs, each at its own link with its own password: **Catalog 1** at `/catalog` (with prices by default) and **Catalog 2** at `/catalog2` (no prices by default). Give a customer whichever link fits. Both share the page below; everything in this section applies to each, with its own settings.

`/catalog` is the wholesale catalog for customers (`lib/catalog.js`, `catalog/index.html`), laid out like `american_seair_imports_wholesale_2025.xlsx`: brand logos, address and phone, then SKU, UPC, name, category, piece price and case price with a picture of each product, grouped under red category headings (Perfumes, Air Freshner, Deodorant, Car Perfume, Incense, Sunglasses, then Diffusers, Cosmetics, Health & Beauty, Electronics). Customers can search, filter by category, and download what they see as a PDF or an Excel file with the pictures in it.

- It reads the same products API as the dashboard (5-minute cache), so prices follow the API. Opened-box, deleted and discontinued SKUs are left out.
- The API has no selling price, only `cost` (the workbook's WHOLESALE COST) and `qty_in_case`. Each catalog applies its own wholesale rules, editable in Catalog management: piece price = cost + 12%, case price (per piece) = cost + 8% by default, both rounded up to the next $0.50 (also editable). A price set for a SKU replaces its piece price.
- Customers can switch between a list and a tile view, filter by category, type, price, new, photo or cart, and build an order in a cart. The cart lives only in their browser for 6 hours; "Copy order" puts it on the clipboard to text or email to sales.
- Stock: each product shows **In stock** (`live_qoh` > 0, on the shelf now), **Available to order** (`qoh` > 0 but not live) or **Ask us** (neither). Customers pick "In stock now" or "All products we carry" at the top; the choice also applies to downloads. Only the status leaves the server, never the counts.
- The API has no picture field, so pictures come from the Jomashop listing data in the API (`igloo_jomashop`), then NocNoc (`igloo_nocnoc`), then any other product with the same UPC. Products with none show "No photo". Pictures are served through `/catalog/img/<sku>`, which only fetches the URL found for that SKU.
- Customers sign in with `CATALOG_PASSWORD` (not the admin token). Sessions work like the dashboard's: 6 hours, tied to the browser, 10 wrong tries per 15 minutes per IP. Everyone, admins included, needs the catalog password: a dashboard sign-in doesn't open the catalog, and a catalog sign-in never opens the dashboard or `/api/*`.
- Only the catalog fields leave the server (`/catalog/data`); costs, vendors, stock and sales stay private.
- Clicking a product's picture opens a bigger view, with arrows to step through the products shown.
- The **Catalog management** page (`public/catalog-admin.html` + `public/js/catalog-admin.js`, admin sign-in) controls it: turn the catalog on or off, show or hide piece and case prices, include every API product except the ones you remove or only the SKUs you add (opened-box and other internal SKUs can be added by hand), and set your own piece price for any SKU. Each catalog has its own settings and its own password, which can be set on that page (stored hashed; it overrides `CATALOG_PASSWORD` / `CATALOG2_PASSWORD` on Render, and changing it signs that catalog's customers out). Settings are saved to `catalog-settings.json` in `COMPETITOR_DATA_DIR` (or `CATALOG_DATA_DIR`), so keep that on the Render disk. Open catalogs pick up changes within a minute, and hidden prices are never sent to customers. API: `GET`/`POST /api/catalog/settings` (admin sign-in).

## Sign-in

The whole dashboard is locked behind `ADMIN_TOKEN` (`lib/auth.js`). Visitors get a sign-in page; the right token starts a session on that browser for `SESSION_HOURS` (default 6), after which they sign in again. Sessions are tied to the browser that signed in, wrong tokens are limited to 10 tries per 15 minutes per IP, and changing `ADMIN_TOKEN` on Render signs everyone out. Without `ADMIN_TOKEN` set the dashboard serves nothing. Scripts can still call `/api/*` with an `x-admin-token` header. Only `/healthz` and `/media/` (logos and icon) are public. The customer catalog at `/catalog` has its own password (see above).
