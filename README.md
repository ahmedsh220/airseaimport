# airseaimport

Reports dashboard for Air Sea Import / Fragrance Wholesaler USA. It reads the live product feed at
`https://hub.fragrancewholesalerusa.com/api/open/products` and turns it into reorder, profit, vendor and stock reports. It also shows TikTok competitor prices from Euka, writes edits back into the pricing workbook in OneDrive, and serves two password-protected customer wholesale catalogs. One Node web service, deployed on Render.

Contents

1. [Run it](#run-it)
2. [How it's built](#how-its-built)
3. [Sign-in and security](#sign-in-and-security)
4. [Where the data comes from](#where-the-data-comes-from)
5. [The dashboard](#the-dashboard)
6. [Formulas](#formulas)
7. [TikTok competitors (Euka)](#tiktok-competitors-euka)
8. [TikTok sales (Euka analytics)](#tiktok-sales-euka-analytics)
9. [Editing the Excel sheet](#editing-the-excel-sheet)
10. [Customer catalogs](#customer-catalogs)
11. [API reference](#api-reference)
12. [Saved files](#saved-files)
13. [Settings (environment variables)](#settings-environment-variables)
14. [What the browser stores](#what-the-browser-stores)
15. [Planned: dashboard assistant (MCP server and chat)](#planned-dashboard-assistant-mcp-server-and-chat)
16. [Troubleshooting](#troubleshooting)

## Run it

Node 18 or newer. There are no npm dependencies, so there is nothing to install.

```sh
cp .env.example .env     # then set at least ADMIN_TOKEN
npm start                # or: node server.js
# open http://localhost:3000 and sign in with ADMIN_TOKEN
```

`server.js` reads `.env` itself on local runs (no dotenv package). Variables already set in the shell win over `.env`.

**Render:** a Node web service with build command `npm install` (nothing to install, but harmless) and start command `npm start`. Settings go under the service's **Environment** tab. Add a persistent disk (for example at `/var/data`) and set `COMPETITOR_DATA_DIR=/var/data`, or competitor results, catalog settings and the Excel edit log are lost on every deploy. Render sets `PORT`; locally it defaults to 3000. `/healthz` answers `ok` for health checks.

## How it's built

Plain Node `http` server, no framework, no build step. Pages are static HTML with inline scripts; charts use Chart.js 4.4.1 from cdnjs. The dashboard pages follow the [Atlassian Design System](https://atlassian.design/get-started) look (its color, type and spacing tokens, side navigation, top bar, lozenges and tables), written as plain CSS in `public/css/ads.css`, so there is still nothing to build. The catalog page loads jsPDF and ExcelJS from a CDN only when a customer downloads.

```
.
├── server.js                 entry point: .env loader, products API proxy and cache, routing, static files
├── lib/
│   ├── auth.js               admin sign-in gate for everything except /catalog*, /healthz, /media/
│   ├── catalog.js            customer catalogs (/catalog, /catalog2) and their settings API
│   ├── competitors.js        Euka competitor search, matching, scheduling, overrides
│   ├── tiktok-sales.js       our TikTok Shop sales by window from Euka analytics
│   └── excel.js              read and write the pricing workbook through Microsoft Graph
├── public/
│   ├── index.html            the dashboard (all report logic and formulas run here, in the browser)
│   ├── catalog-admin.html    Catalog management page
│   ├── css/ads.css           shared look: Atlassian design tokens (light and dark), buttons, tables, top bar, side nav
│   └── js/
│       ├── shell.js          top bar and side navigation shared by both dashboard pages
│       ├── excel-edit.js     "Excel sheet" section of a product's detail view
│       └── catalog-admin.js  Catalog management logic
├── catalog/index.html        customer catalog page (served only after the catalog password)
├── media/                    logos and favicon, public at /media/
└── .env.example              every setting, with defaults
```

### Request flow

Every request goes through `auth.gate` first. Then each module is asked in turn whether the path is theirs, and the first one that answers wins.

```
request
  └─ auth.gate (lib/auth.js)          sign-in page, redirect or 401 unless signed in (catalogs, /healthz, /media/ pass through)
      ├─ /api/products                 server.js: cached products API
      ├─ /catalog*, /catalog2*         catalog.handle: its own password, page, data, pictures
      ├─ /api/catalog/settings         catalog.handleAdmin
      ├─ /api/competitors*             competitors.handle
      ├─ /api/excel*                   excel.handle
      ├─ /api/tiktok-sales             tiktokSales.handle
      ├─ /healthz
      └─ static files                  public/ (no-cache) and media/ (cached 1 day); "/" serves index.html
```

### What happens on boot

1. `.env` is loaded (local runs only).
2. The server starts listening and immediately fetches the products API to warm the cache.
3. Competitor scheduling starts: 15 seconds after boot and then every 15 minutes, any SKU whose result is older than the refresh window is searched again.
4. Every 2 minutes, the products cache is refreshed in the background if it's more than 5 minutes old.

## Sign-in and security

| Who | How they get in | What they can reach |
|---|---|---|
| Admin in a browser | `ADMIN_TOKEN` on `/login` starts a signed cookie session (`asi_session`, HttpOnly, SameSite=Lax, Secure on https) for `SESSION_HOURS` (6) | Dashboard pages and all of `/api/*` |
| Scripts | `x-admin-token: <ADMIN_TOKEN>` header | `/api/*` |
| Catalog customers | The catalog's password (`CATALOG_PASSWORD` / `CATALOG2_PASSWORD`, or one set in Catalog management) | Only their catalog's `/catalog*` or `/catalog2*` paths |
| Anyone | Nothing | `/healthz`, `/media/`, `/favicon.ico`, the sign-in pages |

How it works (`lib/auth.js`):

- The session cookie is `base64url(JSON {exp, dev, id}) . HMAC-SHA256 signature`. The signing key is derived from `ADMIN_TOKEN`, so changing the token on Render signs every admin out.
- `dev` is a hash of the browser's user agent, so a copied cookie doesn't work in another browser.
- Token checks use constant-time comparison. Wrong tokens are limited to 10 tries per 15 minutes per IP (counted in memory, reset on restart).
- `next=` redirects only go to same-site paths.
- Without `ADMIN_TOKEN` set, everything but the catalogs and `/healthz` answers 503.
- Once signed in, the gate adds the `x-admin-token` header to the request inside the server. So admin-only endpoints (competitor refresh, Excel edit) work without asking for the token again.
- The dashboard checks `/api/session` and sends you back to `/login` when the session ends or any `/api/*` call returns 401 with `login` in the body.
- Sign-in and catalog pages send `x-frame-options: DENY`.
- Catalog sessions use the same design with a separate cookie per catalog (scoped to its path) and a key tied to that catalog's password. A catalog session never opens the dashboard, and a dashboard session never opens a catalog.

What never leaves the server: `ADMIN_TOKEN`, catalog passwords (dashboard-set ones are stored as scrypt hashes), `EUKA_API_KEY`, `MS_CLIENT_SECRET`. Customers only ever receive catalog fields, never cost, vendor, stock counts or sales.

## Where the data comes from

| Source | Code | Cache | Used for |
|---|---|---|---|
| Products API (`PRODUCTS_API`) | `server.js`, browser | Server: in memory, refreshed in the background when older than 5 minutes. Browser: last good copy in IndexedDB | Everything |
| Euka Social and Market Intelligence | `lib/competitors.js` | `competitors.json` on disk, each SKU re-searched weekly by default | TikTok competitors tab |
| Euka TikTok Shop analytics | `lib/tiktok-sales.js` | In memory, 60 minutes | Exact TikTok units for 7/14/30/60/90 days |
| Pricing workbook in OneDrive (Microsoft Graph) | `lib/excel.js` | Sheet layout 5 minutes; rows read live | Excel section of a product's detail view, write-back |
| Hub storefront product list (`HUB_IMAGES_API`) | `lib/catalog.js` | In memory, 6 hours | Catalog pictures (last fallback) |

### Products API loading

The upstream API is slow and sometimes cuts responses off, so loading is defensive at both ends.

**In the browser** (`load()` in `public/index.html`):

1. Ask the upstream API directly with a 45 second timeout. Browsers reach it over HTTP/2 and that usually works.
2. If that fails, call our `/api/products` (up to 2 tries, 60 seconds each). The `x-source` header says `live` or `stale`, and `x-fetched-at` says when the server's copy was fetched.
3. A good response is saved to IndexedDB (`asi-dashboard` → `kv` → `products`). If both live routes fail, that saved copy is shown with a note saying how old it is.
4. **Refresh data** repeats this with `?refresh=1`, which makes the server fetch again.

**On the server** (`products()` in `server.js`):

- Once a copy is in memory it is always served straight away. If it's older than 5 minutes, a refresh starts in the background. Only the very first load after a restart waits.
- Concurrent requests share one upstream call.
- Each refresh tries up to 3 times: first over HTTP/2, then HTTP/1.1 with gzip, then without, with 1.5 and 3 second pauses between tries. Each try sends browser-like headers, since the upstream's protection rejects bare server requests.
- A response is only cached if it parses as complete JSON. A failed refresh keeps the last good copy and marks it `stale`.

Field notes on the API (one JSON array, about 134 fields per product):

- Numbers often arrive as strings.
- `actual_cost` is usually 0, so cost falls back to the next field (see [Formulas](#formulas)).
- `first_added_date` and `last_ordered_date` are `MM/DD/YYYY`.
- `sales_sep_sale_price` and `sales_sep_shipping_price_we_paid` are September totals; the shipping one is negative.
- `*_60_days` fields are 60-day units per channel; `sales_90_days` is the 90-day all-channel total.
- Vendor columns (`lux`, `edge`, `tahir`, …) are supplier prices, each with a `<vendor>_date`.
- `igloo*` fields are JSON strings with live listing data per marketplace.
- `qb_customer_sales` holds QuickBooks customer names. It's never shown or sent anywhere.

## The dashboard

`public/index.html` is a single page. All metrics are computed in the browser from the products list, so every number on screen can be traced to the [Formulas](#formulas) below.

`public/index.html` and `public/catalog-admin.html` share one shell (`public/js/shell.js`, styled by `public/css/ads.css`). It follows the system's light or dark mode.

**Top bar:** the Fragrance Wholesaler USA logo and the brand logos (the same files as the catalog header, from `media/`), then Refresh data and Sign out. On narrow screens the brand strip hides and a menu button opens the side navigation.

**Side navigation:** one place for every page.

- **Reports:** Overview, Items sold, Actions, Reorder, Profit & Loss, Sheet view, Vendors, TikTok competitors. Each is a view of the same page at `/#<view>` (`#overview`, `#sold`, `#actions`, `#reorder`, `#pl`, `#sheet`, `#vendors`, `#competitors`), so a view can be bookmarked.
- **Catalog:** Catalog management (`/catalog-admin.html`), and Catalog 1 (`/catalog`) and Catalog 2 (`/catalog2`), which open the customer pages in a new tab.
- At the bottom: how many products are loaded, when the products API last updated, and how far the TikTok Shop data goes.

**Page header:** breadcrumb, the view's title and **Export CSV** (the main table of the current view, with the filters applied).

**Filters** (under the page header, on every report view): search (SKU, name or UPC), **Platform** (all platforms or one of the 14 channels, each listed with its 60-day units; choosing one focuses every view on it, and clicking a bar in a platform chart does the same), Category, and Tier (`pricing_category`: super, hero, green, new, dead, …).

**Plan for the next 7, 14, 30 or 60 days** shows on the Reorder view only. It's a projection (day ave × days), so it only belongs where you plan an order. Every other view shows the API's fixed counts, and projections there (Overview, Sheet view) use 30 days. Nothing on the page estimates past sales: the API has 60-day units per platform and the 90-day all-platform total the reorder math uses, and nothing shorter except TikTok from Euka.

**Views:**

| View | What it shows |
|---|---|
| Overview | Tiles: projected sales for the next 30 days, reorder now (SKUs, cases, cost), runs out within 30 days, out of stock but still selling, stock value. Units by platform chart, running out first, and top sellers projected for 7 to 60 days. Clicking a tile opens Sheet view filtered to those products. |
| Items sold | How many of each product sold in the last 60 days, exact from the API: tiles (units, products sold, top platform or the chosen platform's share, best seller), units by platform chart, units by category (click one to filter), and a products table with one column per platform plus the 60-day total and per-day rate. Show sold products only or all of them; columns can be hidden. When TikTok Shop is connected in Euka, TikTok's exact 7, 14 and 30-day units are added. |
| Actions | Overstock: cash tied up above a 60, 90 or 180-day cover target, with a suggested action and TikTok break-even price. Switch vendor: selling products a vendor quotes cheaper than we pay, with per-order and yearly savings. |
| Reorder | Products at or under the trigger, grouped by supplier, cheapest vendor, top platform or tier (or not grouped), with cases, order quantity and order cost. Show: needs order, all selling, everything. The planning period sets the "Next N days" projections. The sheet's numbers can be changed here (see Settings below). |
| Profit & Loss | Per platform: price rule, average profit per unit, 60-day weighted PFT%, 60-day units, revenue and profit, how many SKUs are under the minimum margin and how many lose money. Click a platform for its per-product P&L. Option: use live listing prices instead of the sheet's price formulas. |
| Sheet view | The workbook's main columns filled from the API. Columns can be hidden per group. |
| Vendors | Each supplier's price list: products quoted, how many they're cheapest on, latest price date. Click one to compare their prices with ours. |
| TikTok competitors | See [TikTok competitors](#tiktok-competitors-euka). |

Clicking any product opens its **detail view**, which has:

- stock and reorder figures
- projected sales and stock left after 7 to 60 days
- a per-platform table of 60-day units and P&L
- every vendor quote
- its row in the Excel workbook, editable (see [Editing the Excel sheet](#editing-the-excel-sheet))

**Settings** ("Change the sheet's numbers" on the Reorder tab) are saved per browser:

| Setting | Default | Used in |
|---|---|---|
| Sales window days | 80 | Day average = `sales_90_days` ÷ this |
| Order multiplier (days) | 45 | How many days of sales an order covers |
| Trigger (days of stock) | 28 | Reorder when days of stock is at or under this |
| Min profit % | 18 | Margin warnings, competitor floor price |
| Misc cost | $0.05 | Added to the total cost to ship |
| Use live listing prices | off | P&L uses live listings instead of the sheet's price formulas |

## Formulas

Excel column letters in brackets refer to the workbook's master tab, which these mirror. The code is `enrich()`, `computePL()` and the `PL` table in `public/index.html`.

### Per product

| Name | Formula |
|---|---|
| Live inv [M] | `live_qoh`, else `qoh` |
| On order [CQ] | `in_progress` |
| Qty in case [AB] | `qty_in_case` (if above 0) |
| Purchase cost | `actual_cost` if above 0, else `purchase_cost`, else `cost` |
| Total cost to ship, Q [Q] | `final_cost` if above 0, else purchase cost + `box_cost` + misc ($0.05) |
| Platform cost, AN [AN] | max(0, Q − `box_cost` − misc) |
| Ship charge, AG [AG] | `ship_cost` |
| Wholesale cost, AS [AS] | `cost` |
| Sold in window [BI] | `sales_90_days` |
| Day ave [BM] | sold ÷ sales window (80). With a platform selected: that platform's 60-day units ÷ 60 |
| Monthly sold [BO] | day ave × 30 |
| Days of stock [L] | live inv ÷ day ave (blank when nothing sold) |
| Need for month [CH] | monthly − live inv |
| Cases on hand [BF] | live inv ÷ case qty |
| Stock value [BG] | platform cost × max(0, live inv) |
| Reorder point | day ave × trigger (28) |
| Trigger | day ave > 0 and floor(live inv ÷ day ave) ≤ 28 |
| Need [CM] | if triggered: max(0, day ave × 45 − live inv − on order), else 0 |
| Cases to order [CU] | round up(need ÷ case qty) |
| Order qty [CW] | cases × case qty (or need rounded up when there's no case qty) |
| Order cost [CX] | order qty × platform cost |
| Sold 60 days [CG] | sum of the 14 `<channel>_60_days` columns |
| Highest day avg | `sales_highest_avg_90_days` ÷ 90 |
| Cheapest quote | lowest of the 22 vendor price columns above 0 |

Days-of-stock colours: red at or under the trigger (or out), amber up to the order multiplier, green under 180 days, grey beyond that.

### Platform P&L

For each platform: profit = price − fee − shipping we pay − base cost, and PFT% = profit ÷ (cost + profit). Base cost is Q unless noted otherwise. Per product, 60-day profit = profit × that platform's 60-day units.

| Platform | Price (sheet formula) | Fee | Shipping we pay | Base |
|---|---|---|---|---|
| TikTok | live TikTok price | 20% | ship charge when price ≥ $30 | Q |
| Amazon | INT(Q × 1.25 + ship) + .99 | 15% | ship charge | Q |
| Walmart | INT(Q × 1.5 + ship) + .99 | 15% | ship charge | Q |
| Temu | (Q + ship + 18% of Q) to nearest .25 | none | ship charge | Q |
| Faire | CEILING(wholesale × 1.364, .25) | 19% | none | platform cost |
| NocNoc | ROUNDUP(Q × 1.29) | 7% | none | Q |
| Shein | INT(Q × 1.7) + .99 | 12% | ship charge | Q |
| eBay | INT(Q × 1.72) + .99 | 12.7% + $0.40 | ship charge | Q |
| Jomashop | CEILING(Q × 1.17, .5) | none | none | platform cost (PFT% on Q) |
| Shopify | INT(Q × 1.6) + .99 | 2.75% + $0.20 | ship charge | Q |
| Poshmark | INT(Q × 1.55) + 1 | 20% ($2.95 at $15 or less) | none | Q |
| Whatnot | INT(Q × 1.42) + .99 | 11% + $0.30 | none | Q |

SeeBiz and Wholesale have sales columns but no profit formula, so they have no P&L.

Live listing prices, used for TikTok always and for the other platforms when the setting is on:

- TikTok: `igloo.tiktok.sell_price`, else `tiktok_same_price`, else the first SKU price in `igloo_tiktok`.
- Amazon, NocNoc, Shopify: their own `igloo_<platform>` price, else `igloo.<platform>.sell_price`.
- Others: `igloo.<platform>.sell_price`.

The platform summary's PFT% is weighted by 60-day units: total 60-day profit ÷ total of (profit + Q) × units.

### Sales over a period

- Projected sales for the next N days = day ave × N (N is the Reorder view's planning period, 30 elsewhere).
- Sold: only exact counts are shown. 60 days per channel (`<channel>_60_days`), the 90-day all-channel total (`sales_90_days`, for the reorder math), and TikTok for 7, 14 and 30 days from Euka. Shorter periods aren't estimated.
- Items sold per day = 60-day units ÷ 60.
- Short in N days = max(0, day ave × N − live inv − on order).

### Actions tab

- **Overstock:** excess units = live inv − day ave × cover days (all of live inv when nothing sells). Cash tied up = excess × platform cost. Action: Liquidate when nothing sells, Mark down when there's over 365 days of stock, else Bundle / promo.
- **TikTok break-even:** Q ÷ 0.8 when that's under $30; otherwise max($30, (Q + ship charge) ÷ 0.8).
- **Switch vendor:** shown when cheapest quote < platform cost and the product sells.
  - Save per unit = platform cost − quote. Per year = save × day ave × 365. On the next order = save × order qty.
  - A quote counts as recent within 90 days of its date.
  - A quote more than 50% below what we pay is flagged "check size".

### TikTok competitor maths

- Lowest, median and highest use only competitors' listed prices. Market Intelligence averages are left out when a listing has several prices.
- Gap = our TikTok price − lowest. Gap % = gap ÷ lowest.
- Our units in 30 days = TikTok 60-day units ÷ 2. Our share = ours ÷ (ours + matched competitors' 30-day units).
- Profit at lowest = lowest − 20% − (ship charge if ≥ $30) − Q.
- **Floor price** is the lowest price that keeps the minimum margin m (18%):
  - need = Q × m ÷ (1 − m)
  - price = (Q + need) ÷ 0.8 when that's under $30
  - otherwise max($30, (Q + ship charge + need) ÷ 0.8), rounded up to the cent
- **Suggested price** = lowest − $0.01, but never below the floor.

### Catalog prices

Piece price = cost × (1 + 12%) and case price per piece = cost × (1 + 8%). Both are rounded up to the next $0.50. All three numbers can be changed per catalog, and a price set for a SKU in Catalog management replaces its piece price. Cost here is the API's `cost` (the workbook's WHOLESALE COST).

## TikTok competitors (Euka)

The **TikTok competitors** tab compares each SKU's TikTok price with up to 5 same-item TikTok Shop listings found through [Euka's OpenAPI](https://server.euka.ai/docs). Code: `lib/competitors.js`.

**Search flow for one SKU:**

1. **Profile:** the product name (before any `|`) is lower-cased and cleaned. Format words (EDP, spray, for women, oz, ml, gift set, …) are dropped, and sizes are read as millilitres (3.4 oz = 100.5 ml).
2. **Queries, most to least specific:**
   - the first 6 words
   - the last 2 words (usually the scent)
   - the last 3 words
   - the first 2 words plus the last one

   Shorter queries only run while nothing has matched yet.
3. **Search both Euka indexes per query:**
   - `GET /social-intelligence/products` gives the current price, strike-through price, shipping and units.
   - `POST /market-intelligence/tiktok/product/rank` (with `need_all`) also finds listings with no recent sales, plus seller, commission and growth.

   Results are merged by TikTok product id. Social Intelligence wins on price; Market Intelligence fills the gaps.
4. **Exclude** our own listings (`tiktok_product_id` and the id in `igloo_tiktok`), shops in `OUR_TIKTOK_SHOP_NAMES`, inactive listings and listings you've hidden.
5. **Score from 0 to 1:** the share of our words found in the title.
   - Same size (within 3 ml or 6%): +0.15.
   - Different size: capped at 0.45.
   - Sample, decant, vial, tester or mini: −0.3, unless ours is one too.
   - Set, bundle or pack: −0.15, unless ours is one too.
6. **Keep** listings scoring at least 0.6, best first, up to 5. Pinned listings always count as 1.0. The next 5 near misses are kept as candidates you can pin.
7. **Detail:** `product/detail` adds the min/max SKU price, creators, videos and reviews for each kept match. When every SKU of a listing has the same price, that price replaces an average.

**Scheduling and limits:**

- **When SKUs are searched:** every 15 minutes the server searches the SKUs whose result is older than `COMPETITOR_REFRESH_HOURS` (168 hours by default, since Euka's quota is weekly).
- **Errors:** a failed SKU is retried after `COMPETITOR_MIN_GAP_HOURS` (2).
- **Refresh all now:** only takes SKUs not searched in the last 2 hours.
- **Pacing:** 2 workers, with at least 1.5 seconds between any two calls. A rate limit (429) pauses every worker, honouring `retry-after`, doubling up to 10 minutes.
- **Weekly quota:** when Euka says the quota is used up, nothing is called until Monday 00:00 UTC. The pause is saved to disk, so it survives restarts.
- **Market Intelligence fallbacks:**
  - Rate limited: it's paused for 30 minutes and Social Intelligence carries on alone.
  - Not available to the key (other 4xx): it's switched off for that run.
- **Saving:** results are written every 10 SKUs, so an interrupted run resumes where it stopped.

**On the page:** hide a wrong match ("Not a match") or pin the right listing. Either one re-checks that SKU right away. Overrides are saved in `competitor-overrides.json`.

## TikTok sales (Euka analytics)

`lib/tiktok-sales.js` loads our own TikTok Shop sales for the last 7, 14, 30, 60 and 90 days from Euka's `dashboard/products-performance`. The products API only has 60 and 90-day totals, so this is the only source for shorter TikTok windows.

- **End date:** a one-day request for yesterday first finds the latest finished reporting day (TikTok reports with a lag). Every window ends on that day.
- **Brand:** it uses the first of the key's Euka brands that has a TikTok Shop connected, or `EUKA_BRAND_ID`.
- **Pages:** up to 100 pages of 100 products per window.
- **Cache:** results are kept for 60 minutes (`TIKTOK_SALES_TTL_MIN`). The last good copy is served while a refresh runs.
- **SKU matching:** the browser matches TikTok products to SKUs by `tiktok_product_id` or the id in `igloo_tiktok`, or by the seller SKU when a listing has exactly one.

## Editing the Excel sheet

Each product's detail view has an **Excel sheet** section showing that SKU's row from the master tab of the workbook in OneDrive (`TIKTOK PRICING 786110.xlsx`, sheet `0. MASTER` by default). Type in any column and press **Save to Excel**. The server writes the cells through Microsoft Graph, the same as someone editing the file in Excel Online, so anything syncing from the live file (the QuickBooks sync) picks the change up. Code: `lib/excel.js`, `public/js/excel-edit.js`.

**Flow:**

1. The server signs in as an Entra app (client credentials, token cached until a minute before expiry). It finds the workbook from `EXCEL_FILE_URL`, or from `EXCEL_USER` plus `EXCEL_PATH`.
2. **Layout** (cached 5 minutes):
   - Read the sheet's used range.
   - Find the header row holding `SKU #` within the first 40 rows.
   - Label repeated headers with their column letter.
   - Map each SKU to its row number.
3. **Row:** read values, formulas and display text for the SKU's row. Each cell is editable unless it's the SKU column, holds a formula, or is listed in `EXCEL_LOCKED_COLUMNS`.
   - If the SKU appears on two rows, the server refuses rather than guess.
   - If the sheet was re-sorted and the SKU moved, the layout is re-read once.
4. **Save:** for each changed cell, the server checks five things before writing:
   - the column still has the same header
   - the cell isn't a formula or locked
   - the new value doesn't start with `=`
   - the cell still holds what the page loaded, so an edit made in Excel meanwhile isn't overwritten
   - the value actually changed

   Then it PATCHes that one cell. Graph throttling (429, 503, 504) is retried up to 3 times.
5. **Log:** every change is appended to `excel-edits.jsonl` (time, editor name, SKU, row, column, from, to) and printed to the server log.

**Setup:**

1. In the Microsoft Entra admin center, create an app registration.
2. Add the Microsoft Graph **application** permission `Files.ReadWrite.All`, grant admin consent, and create a client secret.
3. Set `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` (and `ADMIN_TOKEN`) in Render → Environment.

## Customer catalogs

There are two customer catalogs, each at its own link with its own password: **Catalog 1** at `/catalog` (with prices by default) and **Catalog 2** at `/catalog2` (no prices by default). Give a customer whichever link fits. Both share the page below; everything in this section applies to each, with its own settings.

`/catalog` is the wholesale catalog for customers (`lib/catalog.js`, `catalog/index.html`), laid out like `american_seair_imports_wholesale_2025.xlsx`: brand logos, address and phone, then SKU, UPC, name, category, piece price and case price with a picture of each product, grouped under red category headings (Perfumes, Air Freshner, Deodorant, Car Perfume, Incense, Sunglasses, then Diffusers, Cosmetics, Health & Beauty, Electronics). Customers can search, filter by category, and download what they see as a PDF or an Excel file with the pictures in it.

- It reads the same products API as the dashboard (5-minute cache), so prices follow the API. Opened-box, deleted and discontinued SKUs are left out.
- The API has no selling price, only `cost` (the workbook's WHOLESALE COST) and `qty_in_case`. Each catalog applies its own wholesale rules, editable in Catalog management: piece price = cost + 12%, case price (per piece) = cost + 8% by default, both rounded up to the next $0.50 (also editable). A price set for a SKU replaces its piece price.
- Customers can switch between a list and a tile view, filter by category, type, price, new, photo or cart, and build an order in a cart. The cart lives only in their browser for 6 hours; "Copy order" puts it on the clipboard to text or email to sales.
- Stock: each product shows **In stock** (`live_qoh` > 0, on the shelf now), **Available to order** (`qoh` > 0 but not live) or **Ask us** (neither). Customers pick "In stock now" or "All products we carry" at the top; the choice also applies to downloads. Only the status leaves the server, never the counts.
- The API has no picture field, so pictures come from the Jomashop listing data in the API (`igloo_jomashop`), then NocNoc (`igloo_nocnoc`), then any other product with the same UPC, and last the picture on the hub storefront's product list (`/api/ecom/search`, matched by the QuickBooks item id, then SKU, then barcode; reloaded every 6 hours, URL in `HUB_IMAGES_API`). Products with none show "No photo". Pictures are served through `/catalog/img/<sku>`, which only fetches the URL found for that SKU.
- Customers sign in with `CATALOG_PASSWORD` (not the admin token). Sessions work like the dashboard's: 6 hours, tied to the browser, 10 wrong tries per 15 minutes per IP. Everyone, admins included, needs the catalog password: a dashboard sign-in doesn't open the catalog, and a catalog sign-in never opens the dashboard or `/api/*`.
- Only the catalog fields leave the server (`/catalog/data`); costs, vendors, stock and sales stay private.
- Clicking a product's picture opens a bigger view, with arrows to step through the products shown.
- The **Catalog management** page (`public/catalog-admin.html` + `public/js/catalog-admin.js`, admin sign-in) controls it: turn the catalog on or off, show or hide piece and case prices, include every API product except the ones you remove or only the SKUs you add (opened-box and other internal SKUs can be added by hand), and set your own piece price for any SKU. Each catalog has its own settings and its own password, which can be set on that page (stored hashed; it overrides `CATALOG_PASSWORD` / `CATALOG2_PASSWORD` on Render, and changing it signs that catalog's customers out). Settings are saved to `catalog-settings.json` in `COMPETITOR_DATA_DIR` (or `CATALOG_DATA_DIR`), so keep that on the Render disk. Open catalogs pick up changes within a minute, and hidden prices are never sent to customers. API: `GET`/`POST /api/catalog/settings` (admin sign-in).

## API reference

All `/api/*` routes need an admin session or `x-admin-token`. Responses are JSON.

| Method and path | What it does |
|---|---|
| `GET /api/products` (`?refresh`) | The products API body as-is. Headers `x-fetched-at` (when the server fetched it) and `x-source` (`live` or `stale`). 502 when there's no copy at all. |
| `GET /api/session` | `{ expiresAt }` for the current browser session (null for header auth). |
| `GET /api/competitors` | Everything the tab needs: `configured, running, progress, runAt, finishedAt, errors, refreshHours, perSku, minScore, region, nextRunAt, quotaUntil, minGapHours, saved, sources, marketIntel, skus{sku: {checkedAt, queries, calls, matches[], candidates[], error}}, overrides`. |
| `GET /api/competitors/status` | Checks the Euka key (`/me`, cached 10 minutes): `configured, keyOk, key, error, running, progress, lastCall`. |
| `GET /api/competitors/product/<id>` | One TikTok listing straight from Euka. |
| `POST /api/competitors/refresh` | Body `{ "skus": [...] }` optional. 3 SKUs or fewer: waits and returns their results. Otherwise 202 and runs in the background. 409 if a run is going. |
| `POST /api/competitors/override` | `{ sku, productId, action: "ignore" \| "pin" \| "clear" }`. Saves it and re-checks that SKU. |
| `GET /api/tiktok-sales` (`?refresh`) | `{ configured, error, fetchedAt, end, latestAvailableDate, windows: { 7: { start, end, totalCount, complete, products: [{ id, units, gmv, orders, skus }] }, … } }`. |
| `GET /api/excel` (`?refresh`) | Connection status, workbook name and link, header row, row count, columns. |
| `GET /api/excel/row?sku=` | `{ sku, row, sheet, cells: [{ col, header, label, value, text, editable, reason, formula? }] }`. 404 if not on the sheet, 409 if on two rows. |
| `POST /api/excel/edit` | `{ sku, editor, changes: [{ col, header, expected, value }] }` (up to 200). Returns `results` per cell with `ok` or `error`. |
| `GET /api/excel/log` (`?limit=`, max 500) | Latest edits, newest first. |
| `GET /api/catalog/settings` | Both catalogs' settings (no password hashes), whether settings persist, and every product with its catalog fields. |
| `POST /api/catalog/settings` | `{ catalog: "1" \| "2", enabled, showPrices, showCasePrices, pieceMarkupPct, caseMarkupPct, roundTo, mode: "all" \| "selected", hidden[], added[], prices{sku: price}, newPassword?, clearPassword?, editor }`. |

Admin `POST`s to competitors and Excel also accept `?token=<ADMIN_TOKEN>`.

Other routes:

| Path | Who | What |
|---|---|---|
| `GET /login`, `POST /login` (`token`, `next`), `GET /logout` | anyone | Admin sign-in |
| `/`, `/index.html`, `/catalog-admin.html`, `/js/*`, `/css/*` | admin | Dashboard pages |
| `/catalog`, `/catalog2` | password | Catalog page or its sign-in |
| `POST /catalog/login` (`password`), `GET /catalog/logout` | anyone | Catalog sign-in (same under `/catalog2`) |
| `GET /catalog/data` | catalog session | Listed products with only catalog fields and stock status |
| `GET /catalog/img/<sku>` | catalog session | That SKU's picture, fetched through the server (images only, up to 8 MB, cached 1 day) |
| `/media/*`, `/healthz` | anyone | Logos and icon; health check |

## Saved files

Everything is written to the data directory: `COMPETITOR_DATA_DIR`, which defaults to `./data` and is git-ignored. Catalog settings can go elsewhere with `CATALOG_DATA_DIR`, and the Excel log with `EXCEL_DATA_DIR`. Writes go to a `.tmp` file first and are then renamed, so a crash can't leave half a file.

| File | Written by | Holds |
|---|---|---|
| `competitors.json` | Competitor runs | Per-SKU matches and candidates, run times, quota pause, Market Intelligence state |
| `competitor-overrides.json` | Pin and Not a match | `{ sku: { ignore: [ids], pin: [ids] } }` |
| `catalog-settings.json` | Catalog management | Per-catalog settings, including hashed passwords |
| `excel-edits.jsonl` | Excel saves | One line per cell changed |

The products list is never written to disk on the server.

## Settings (environment variables)

All of these are in `.env.example`. Only `ADMIN_TOKEN` is required.

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_TOKEN` | (none) | Dashboard sign-in and `x-admin-token`. Nothing but the catalogs is served without it. |
| `SESSION_HOURS` | 6 | How long a dashboard sign-in lasts on one browser. |
| `PORT` | 3000 | Set by Render. |
| `PRODUCTS_API` | hub `/api/open/products` | The products feed. |
| `CATALOG_PASSWORD` / `CATALOG2_PASSWORD` | (none) | Catalog passwords. A password set in Catalog management overrides these. |
| `CATALOG_SESSION_HOURS` | `SESSION_HOURS` | How long a catalog sign-in lasts. |
| `CATALOG_NEW_DAYS` | 30 | Products added within this many days get the NEW tag. |
| `CATALOG_DATA_DIR` | `COMPETITOR_DATA_DIR` | Where catalog settings are saved. |
| `HUB_IMAGES_API` | hub `/api/ecom/search` | Storefront product list used for catalog pictures. |
| `EUKA_API_KEY` | (none) | Turns on competitors and TikTok sales. |
| `EUKA_BRAND_ID` | first brand on the key | Which Euka brand to read as. |
| `EUKA_API_BASE` | `https://server.euka.ai/api/v1` | |
| `EUKA_PRODUCT_SEARCH_PATH` | `/social-intelligence/products` | |
| `EUKA_SOURCES` | `social,market` | Which Euka indexes to search. |
| `EUKA_MI_DETAIL` | 1 | Fetch `product/detail` for each kept match. |
| `EUKA_MI_CATEGORY_IDS` | (none) | Limit Market Intelligence search to these TikTok categories. |
| `EUKA_REGION` | US | |
| `EUKA_CONCURRENCY` | 2 | Parallel workers. |
| `EUKA_MIN_INTERVAL_MS` | 1500 | Minimum gap between any two Euka calls. |
| `EUKA_DELAY_MS` | 250 | Extra pause between SKUs and fallback queries. |
| `COMPETITORS_PER_SKU` | 5 | Matches kept per SKU. |
| `COMPETITOR_REFRESH_HOURS` | 168 | How old a SKU's result gets before it is searched again. |
| `COMPETITOR_MIN_GAP_HOURS` | 2 | Never re-search a SKU sooner than this, even from "Refresh all now"; retry failures after this. |
| `COMPETITOR_MIN_SCORE` | 0.6 | Match threshold. |
| `OUR_TIKTOK_SHOP_NAMES` | (none) | Our shop names, left out of competitors. |
| `COMPETITOR_DATA_DIR` | `./data` | Data directory. Point it at the Render disk. |
| `TIKTOK_SALES_TTL_MIN` | 60 | Minutes to cache TikTok sales. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | (none) | Entra app for Excel write-back. |
| `EXCEL_FILE_URL` | (none) | Link to the workbook (takes precedence over user + path). |
| `EXCEL_USER` | `office@americanseairimports.onmicrosoft.com` | Workbook owner. |
| `EXCEL_PATH` | `TIKTOK PRICING 786110.xlsx` | Path in their OneDrive. |
| `EXCEL_SHEET` | `0. MASTER` | Sheet to edit. |
| `EXCEL_SKU_HEADER` | `SKU #` | Header of the SKU column. |
| `EXCEL_HEADER_ROW` | 0 (find it) | Header row number, if it shouldn't be detected. |
| `EXCEL_LOCKED_COLUMNS` | (none) | Columns (letters or headers) that stay read only. |
| `EXCEL_DATA_DIR` | `COMPETITOR_DATA_DIR` | Where the edit log is saved. |
| `MS_GRAPH_BASE`, `MS_LOGIN_BASE` | Microsoft defaults | Override Graph and sign-in hosts. |

## What the browser stores

| Key | Where | What |
|---|---|---|
| `asi-dashboard` / `products` | IndexedDB | Last good products list, shown if the API is down |
| `asi-v4-state` | localStorage | Current view, planning period, platform, grouping, filters |
| `asi-v4-settings` | localStorage | The sheet's numbers (see Settings) |
| `asi-v4-hidden` | localStorage | Hidden columns in Sheet view and Items sold |
| `asi-editor` | localStorage | Your name for the Excel edit history |
| `asi-admin-token` | localStorage | Only if you're ever asked for the token on a 401 (header-auth fallback) |
| catalog cart | localStorage on the catalog page | A customer's cart, for 6 hours |

## Planned: dashboard assistant (MCP server and chat)

Status: **planned, not built.** This section is the agreed design, kept here so the build follows it.

**Goal:** ask plain questions inside the dashboard ("what should I reorder from Lux?", "where are we undercut on TikTok?") and get answers that match the tabs, without exposing the raw product feed.

```
Browser (signed in)            Render web service
Assistant panel ── POST /api/assistant/chat (streamed) ──► auth.gate ─► lib/assistant/chat.js (model loop)
                                                                          │ calls tools in-process
External agent (optional, off) ── POST /mcp (MCP_TOKEN / OAuth) ──►  lib/assistant/tools.js (read-only)
                                                                          │ same productList(), competitors, sales
                                                                          ▼
                                                                 model provider (OpenAI or Anthropic), key server-side
```

**Build steps:**

1. **Shared metrics:** move `enrich`, `computePL`, `PL`, `CHANNELS` and `VENDORS` out of `public/index.html` into `public/js/metrics.js`, loaded by both the page and the server, so the assistant's numbers can't drift from the tabs. The page's settings travel with each chat request.
2. **Read-only tools:** `inventory_summary`, `find_products` (up to 10), `product_detail` (one SKU), `reorder_list`, `top_sellers`, `dead_and_overstock`, `vendor_savings` (lists up to 25 rows plus totals), `channel_mix`, `tiktok_competitors`, `tiktok_sales`, `data_status`.
3. **Chat route:** `POST /api/assistant/chat`, streamed with server-sent events, with a provider switch (`AI_PROVIDER=openai|anthropic`), a rate limit and a log.
4. **Chat panel:** an "Ask" panel in the top bar.
5. **MCP endpoint:** `/mcp` (official MCP SDK, streamable HTTP), off unless turned on.
6. **Later:** voice (OpenAI gpt-realtime), write actions behind confirm buttons, and an outside agent (an OpenAI Dot, ChatGPT or Claude) connected to `/mcp`.

**Data safety rules:**

1. Chat sits behind the admin sign-in. `/mcp` is off by default and uses its own credential (OAuth 2.1 per the MCP spec, `MCP_TOKEN` only as a stopgap), never `ADMIN_TOKEN`.
2. Read-only, with no internet, email or write tools. The tools only read what the server already holds.
3. Small answers: row caps and totals, one SKU per detail call, no export tool.
4. Field allow-list. Customer names (`qb_customer_sales`), raw `igloo_*` JSON, internal ids and notes are never returned. `ASSISTANT_HIDE` can hide more.
5. Model keys stay server-side. Ask the provider for zero data retention (API data isn't used for training by default).
6. Untrusted text stays data. Product names and Euka titles are never instructions, and answers render as plain text with no auto-loading links or images. This avoids the combination behind real MCP leaks: untrusted text, broad access and a way to send data out.
7. Only our own code: no third-party MCP servers, and npm packages pinned to exact versions.
8. Limits, a log and an alert:
   - 20 questions per 10 minutes per session, 8 tool calls per question.
   - `assistant-log.jsonl` records the question, the tools used and how many rows each returned. The data itself is never logged.
   - A warning goes to the Render log on unusual volume.

**Model choice:** start with OpenAI GPT-6.1 Sol through the Responses or Agents API, with Claude Sonnet 5.5 (`claude-sonnet-5-5`) behind the same switch for comparison. OpenAI's Dots (announced at DevDay on 29 Sept 2026) are always-on agents inside ChatGPT and can't be embedded in the page. A Dot could connect to `/mcp` later if OpenAI allows custom MCP servers.

**Planned settings** (added to `.env.example` with the code): `AI_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ASSISTANT_ENABLED`, `ASSISTANT_MAX_ROWS` (25), `ASSISTANT_RATE` (20/10m), `ASSISTANT_HIDE`, `MCP_TOKEN`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "The dashboard is locked" (503) | `ADMIN_TOKEN` isn't set on Render. |
| Everyone got signed out | `ADMIN_TOKEN` changed, the 6 hours ran out, or the browser's user agent changed (a browser update). |
| "Couldn't load the products API" | The upstream API is down or cutting responses off. The page falls back to the server's copy, then the browser's saved copy. Try **Refresh data** in a minute. Server logs show each attempt (`Products fetch attempt …`). |
| Data says "last good copy from …" | The server is serving its stale copy while the upstream fails. |
| Competitor results vanish after a deploy | `COMPETITOR_DATA_DIR` isn't on a persistent disk (the tab shows "Results reset when the server restarts"). |
| "Euka's weekly limit is used up" | Searching resumes Monday 00:00 UTC on its own. |
| "Market intelligence unavailable" | The key's plan lacks it, or it's rate limited. Product search carries on alone. |
| TikTok numbers marked est. | Connect the TikTok Shop in Euka so `/api/tiktok-sales` has data. |
| Excel section says not connected | Set the three `MS_*` variables. "Couldn't open the workbook" means the file path or permission is wrong. |
| Excel save says "changed in Excel since you opened it" | Someone edited that cell. Reopen the product to load the new value. |
| Catalog says it's locked | Set its password in Catalog management or on Render. |
