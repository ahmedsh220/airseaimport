# airseaimport

Reports dashboard for Air Sea Import / Fragrance Wholesaler USA. It reads the live product feed at
`https://hub.fragrancewholesalerusa.com/api/open/products` and turns it into reorder, profit, vendor and stock reports. It also shows TikTok competitor prices from Euka, writes edits back into the pricing workbook in OneDrive, serves password-protected customer wholesale catalogs, and keeps an activity log of who came by and what changed. One Node web service, deployed on Render from `main`.

Contents

1. [Run it](#run-it)
2. [How it's built](#how-its-built)
3. [Sign-in and security](#sign-in-and-security)
4. [Where the data comes from](#where-the-data-comes-from)
5. [The dashboard](#the-dashboard)
6. [Formulas](#formulas)
7. [TikTok competitors (Euka)](#tiktok-competitors-euka)
8. [Editing the Excel sheet](#editing-the-excel-sheet)
9. [Customer catalogs](#customer-catalogs)
10. [Activity log](#activity-log)
11. [API reference](#api-reference)
12. [Saved files](#saved-files)
13. [Settings (environment variables)](#settings-environment-variables)
14. [What the browser stores](#what-the-browser-stores)
15. [Troubleshooting](#troubleshooting)

## Run it

Node 18 or newer. There are no npm dependencies, so there is nothing to install.

```sh
cp .env.example .env     # then set at least ADMIN_TOKEN
npm start                # or: node server.js
# open http://localhost:3000 and sign in with ADMIN_TOKEN
```

`server.js` reads `.env` itself on local runs (no dotenv package). Variables already set in the shell win over `.env`.

**Render:** a Node web service with build command `npm install` (nothing to install, but harmless) and start command `npm start`. Every push to `main` deploys. Settings go under the service's **Environment** tab. Render sets `PORT`; locally it defaults to 3000. `/healthz` answers `ok` for health checks.

**Going live checklist (Render):**

1. Set `ADMIN_TOKEN` to a long random value (20+ characters). Nothing but the catalogs opens without it.
2. Add a **persistent disk** (service → Disks, mount path `/var/data`, 1 GB is plenty) and set `COMPETITOR_DATA_DIR=/var/data`. Without it, catalog settings and passwords, competitor results and the activity log are wiped on every deploy and restart. The Activity log and Catalog management pages show a warning while this is missing.
3. Set each catalog's password (Catalog management, or `CATALOG_PASSWORD`, `CATALOG2_PASSWORD`, …). A catalog without one stays locked.
4. Optional: `EUKA_API_KEY` for TikTok competitors, and the three `MS_*` variables for Excel write-back.

## How it's built

Plain Node `http` server, no framework, no build step. Pages are static HTML plus plain scripts in `public/js/`; charts use Chart.js 4.4.1 from cdnjs. Every page follows the [Atlassian Design System](https://atlassian.design/get-started) look (its color, type and spacing tokens, side navigation, top bar, dropdown menus, lozenges and tables), written as plain CSS in `public/css/ads.css` and shared by the reports page, Catalog management, both sign-in pages and the customer catalog, so there is still nothing to build. The catalog keeps its own layout and only borrows the tokens and components, always in the light theme. The catalog page loads jsPDF and ExcelJS from a CDN only when a customer downloads.

```
.
├── server.js                 entry point: .env loader, products API proxy and cache, routing, static files
├── lib/
│   ├── activity.js           the activity log file: writing, 90-day clean-up, /api/activity
│   ├── auth.js               admin sign-in gate for everything except /catalog*, /healthz, /media/, /css/
│   ├── catalog.js            customer catalogs (/catalog, /catalog2, …), adding and removing them, their settings API
│   ├── competitors.js        Euka competitor search in batches of 100, matching, overrides
│   ├── excel.js              read and write the pricing workbook through Microsoft Graph
│   └── http.js               request body caps, JSON answers, per-IP rate limits
├── public/
│   ├── index.html            the reports page: page header, detail dialog and report-only styles
│   ├── catalog-admin.html    Catalog management page
│   ├── activity.html         Activity log page (view, search, download)
│   ├── css/ads.css           the design system: tokens (light and dark), components, app shell, sign-in card
│   └── js/
│       ├── reports.js        all report logic and formulas (runs in the browser)
│       ├── shell.js          top bar, side navigation and the light/dark switch, for every signed-in page
│       ├── ui.js             shared components: dropdown menu, select, pagination
│       ├── platforms.js      sales platform names, colors and logos
│       ├── excel-edit.js     "Excel sheet" section of a product's detail view
│       └── catalog-admin.js  Catalog management logic
├── catalog/index.html        customer catalog page (served only after the catalog password)
├── media/                    logos and favicon, public at /media/
└── .env.example              every setting, with defaults
```

### Request flow

Every request first gets the security headers, and a `POST` from another site is refused (403). Then it goes through `auth.gate`, and each module is asked in turn whether the path is theirs; the first one that answers wins. An error anywhere answers 500 and is logged; it never stops the server.

```
request
  ├─ security headers, per-IP rate limits, cross-site POST check (server.js)
  └─ auth.gate (lib/auth.js)          sign-in page, redirect or 401 unless signed in (catalogs, /healthz, /media/, /css/ pass through)
      ├─ /api/products                 server.js: cached products API
      ├─ /catalog, /catalogN           catalog.handle: its own password, page, data, pictures
      ├─ /api/catalog/*                catalog.handleAdmin: list, add, remove, settings
      ├─ /api/competitors*             competitors.handle
      ├─ /api/excel*                   excel.handle
      ├─ /api/activity*                activity.handle
      ├─ /healthz
      └─ static files                  public/ (no-cache) and media/ (cached 1 day); "/" serves index.html
```

### What happens on boot

1. `.env` is loaded (local runs only).
2. The server starts listening, trims the activity log to the last 90 days (again every 6 hours) and writes a `SERVER START` line, then fetches the products API to warm the cache.
3. Every 2 minutes, the products cache is refreshed in the background if it's more than 5 minutes old.

## Sign-in and security

| Who | How they get in | What they can reach |
|---|---|---|
| Admin in a browser | `ADMIN_TOKEN` on `/login` starts a signed cookie session (`asi_session`, HttpOnly, SameSite=Lax, Secure on https) for `SESSION_HOURS` (6) | Dashboard pages and all of `/api/*` |
| Scripts | `x-admin-token: <ADMIN_TOKEN>` header | `/api/*` |
| Catalog customers | The catalog's password (`CATALOG_PASSWORD`, `CATALOG<N>_PASSWORD`, or one set in Catalog management) | Only their own catalog's paths |
| Anyone | Nothing | `/healthz`, `/media/`, `/css/`, `/favicon.ico`, the sign-in pages |

How it works (`lib/auth.js`):

- The session cookie is `base64url(JSON {exp, dev, id}) . HMAC-SHA256 signature`. The signing key is derived from `ADMIN_TOKEN`, so changing the token on Render signs every admin out.
- `dev` is a hash of the browser's user agent, so a copied cookie doesn't work in another browser.
- Token and password checks use constant-time comparison. Wrong tries are limited to 10 per 15 minutes per IP, and to 200 per 15 minutes from everyone together (past that, new sign-ins pause until the window ends; anyone signed in stays in). The dashboard and the catalogs are counted separately, in memory, reset on restart. A wrong `x-admin-token` header counts the same as a wrong sign-in. Every sign-in, failed sign-in and block is written to the [activity log](#activity-log).
- The IP used for those limits is `CF-Connecting-IP`, which Cloudflare (in front of Render) sets itself. `X-Forwarded-For` is only a fallback, because Render keeps whatever a client puts at its start.
- Rate limits per IP: 600 requests a minute overall, and 60 a minute for anything that changes something (`POST`). Past that the server answers 429 for the rest of the minute. "Refresh data" re-fetches the products API at most every 30 seconds.
- `next=` redirects only go to same-site paths (not `//host` or `/\host`).
- Without `ADMIN_TOKEN` set, everything but the catalogs and `/healthz` answers 503.
- Once signed in, the gate adds the `x-admin-token` header to the request inside the server. So admin-only endpoints (competitor refresh, Excel edit) work without asking for the token again.
- The dashboard checks `/api/session` and sends you back to `/login` when the session ends or any `/api/*` call returns 401 with `login` in the body.
- Every response carries `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: same-origin`, on https `strict-transport-security`, and a `content-security-policy`: scripts only from this server and the pinned libraries on cdnjs and jsDelivr, network calls only to this server, no plugins, forms only post here, and no page can be framed by another site.
- A `POST` whose `Origin` is another site is refused before it reaches any handler. Together with `SameSite=Lax` cookies this blocks cross-site form and script submissions.
- The admin token is only accepted from the sign-in form or the `x-admin-token` header, never from a URL, so it can't end up in browser history or server logs.
- Request bodies are capped (4 KB for sign-in forms, 100 KB for API calls, 2 MB for catalog settings), so an oversized upload is refused before it's read into memory (`lib/http.js`).
- Any error inside a request answers 500 and is printed to the server log; one bad request can't take the server down.
- Catalog sessions use the same design with a separate cookie per catalog (scoped to its path) and a key tied to that catalog's password. A catalog session never opens the dashboard, and a dashboard session never opens a catalog.

What never leaves the server: `ADMIN_TOKEN`, catalog passwords (dashboard-set ones are stored as scrypt hashes), `EUKA_API_KEY`, `MS_CLIENT_SECRET`. Customers only ever receive catalog fields, never cost, vendor, stock counts or sales.

## Where the data comes from

| Source | Code | Cache | Used for |
|---|---|---|---|
| Products API (`PRODUCTS_API`) | `server.js` | In memory on the server, refreshed in the background when older than 5 minutes. The browser keeps no copy | Everything |
| Euka Social and Market Intelligence | `lib/competitors.js` | `competitors.json` on disk, searched 100 SKUs per click | TikTok competitors tab |
| Pricing workbook in OneDrive (Microsoft Graph) | `lib/excel.js` | Sheet layout 5 minutes; rows read live | Excel section of a product's detail view, write-back |
| Hub storefront product list (`HUB_IMAGES_API`) | `lib/catalog.js` | In memory, 6 hours | Catalog pictures (last fallback) |

### Products API loading

The upstream API is slow and sometimes cuts responses off, so loading is defensive at both ends.

**In the browser** (`load()` in `public/js/reports.js`):

1. Call our `/api/products` (sign-in required; up to 2 tries, 60 seconds each). The browser never calls the hub itself. The `x-source` header says `live` or `stale`, and `x-fetched-at` says when the server's copy was fetched. Data answers are sent `private, no-store`.
2. Nothing is saved in the browser. If the server can't answer, the page says so.
3. **Refresh data** repeats this with `?refresh=1`, which makes the server fetch again.

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

The reports page is `public/index.html` with its logic in `public/js/reports.js`. All metrics are computed in the browser from the products list, so every number on screen can be traced to the [Formulas](#formulas) below.

Every signed-in page uses the shell in `public/js/shell.js`, styled by `public/css/ads.css`. It works from phone to desktop.

**Top bar**, left to right:

- The Fragrance Wholesaler USA logo and name (links to Overview).
- **Filters** (reports page only): **Platform** (each of the 14 channels with its logo and 60-day units), **Category** and **Tier** (`pricing_category`, each with its color dot: super, hero, green, new, dead, …). Choosing a platform focuses every view on it; clicking a platform in the Platform mix list does the same.
- **Search** (SKU, name or UPC). Typing filters the current view and opens a dropdown of the 8 best matches (tier color, SKU, name, units on hand). Picking one opens that product's detail. While a search is on, the view starts with "Showing results for …" and a Clear search button.
- **Reset** (shows while a filter or search is on) clears the filters and the search.
- **Refresh**, the light/dark switch (Light, Dark or Match device, saved per browser) and **Sign out**.

On a phone the menu button opens the side navigation, and the filters and search move to a second row that scrolls sideways.

**Side navigation:** one place for every page.

- **Reports:** Overview, Items sold, Reorder, Profit & Loss, Product master, Vendors, TikTok competitors, Insights. Each is a view of the same page at `/#<view>` (`#overview`, `#sold`, `#reorder`, `#pl`, `#master`, `#vendors`, `#competitors`, `#insights`), so a view can be bookmarked. Old links (`#sheet`, `#actions`) still open the renamed views.
- **Catalog:** Catalog management (`/catalog-admin.html`), and a link to each customer catalog (`/catalog`, `/catalog2`, …), which opens it in a new tab.
- **Admin:** Activity log (`/activity.html`), see [Activity log](#activity-log).
- At the bottom: our brand logos, how many products are loaded and when the products API last updated.

**Page header:** the view's title and **Export CSV** (the main table of the current view, with the filters applied). On a phone the intro text under it shows two lines until tapped, and the tiles sit two to a row.

**Tables:** click a heading to sort. Every table is paged, so no row is cut off (50 rows a page by default, 10 for the small side tables such as Running out first; totals always cover every row). The expand button at the top right of each table card opens it in a large view (Esc or the button again closes it), where long names show in full. Product master and Items sold have a **Columns** menu to hide columns, saved per browser.

**Plan for the next 7, 14, 30 or 60 days** shows on the Reorder view only. It's a projection (day ave × days), so it only belongs where you plan an order. Every other view shows the API's fixed counts, and projections there (Overview, Product master) use 30 days. Nothing on the page estimates past sales: the API has 60-day units per platform and the 90-day all-platform total the reorder math uses, and nothing shorter.

**Views:**

| View | What it shows |
|---|---|
| Overview | Tiles: projected sales for the next 30 days, reorder now (SKUs, cases, cost), runs out within 30 days, out of stock but still selling, stock value. Platform mix, running out first, and top sellers projected for 7 to 60 days. Clicking a tile opens Product master filtered to those products. |
| Items sold | How many of each product sold in the last 60 days, exact from the API: tiles (units, products sold, top platform or the chosen platform's share, best seller), Platform mix (each platform's units, share, products selling and best seller), units by category (click one to filter), and a products table with one column per platform plus the 60-day total and per-day rate. Show sold products only or all of them. |
| Reorder | Products at or under the trigger, grouped by supplier, cheapest vendor, top platform or tier (or not grouped), with cases, order quantity and order cost. Show: needs order, all selling, everything. The planning period sets the "Next N days" projections. The sheet's numbers can be changed here (see Settings below). |
| Profit & Loss | Per platform: price rule, average profit per unit, 60-day weighted PFT%, 60-day units, revenue and profit, how many SKUs are under the minimum margin and how many lose money. Click a platform for its per-product P&L. Option: use live listing prices instead of the sheet's price formulas. |
| Product master | The workbook's main columns filled from the API, for every product. |
| Vendors | Each supplier's price list: products quoted, how many they're cheapest on, latest price date. Click one to compare their prices with ours. |
| TikTok competitors | See [TikTok competitors](#tiktok-competitors-euka). |
| Insights | Overstock: cash tied up above a 60, 90 or 180-day cover target, with a suggested action and TikTok break-even price. Switch vendor: selling products a vendor quotes cheaper than we pay, with per-order and yearly savings. |

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

Excel column letters in brackets refer to the workbook's master tab, which these mirror. The code is `enrich()`, `computePL()` and the `PL` table in `public/js/reports.js`.

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
- Sold: only exact counts are shown. 60 days per channel (`<channel>_60_days`), and the 90-day all-channel total (`sales_90_days`, for the reorder math). Shorter periods aren't estimated.
- Items sold per day = 60-day units ÷ 60.
- Short in N days = max(0, day ave × N − live inv − on order).

### Insights

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

- **When SKUs are searched:** only when you click. Nothing runs on a timer. **Search next 100** searches the next 100 SKUs (`COMPETITOR_BATCH_SIZE`) in SKU order, starting after the last SKU the previous batch got through. After the last SKU it starts over from the top. The tab shows which SKUs the next batch covers ("SKUs 101–200 of 1,234").
- **Where a batch stops:** the position is saved with the results, so a batch cut short by a restart, the weekly quota or a rejected key carries on from the first SKU it missed. A SKU that failed for any other reason shows its error and counts as done; **Re-check now** on that product tries it again.
- **Pacing:** 2 workers, with at least 1.5 seconds between any two calls. A rate limit (429) pauses every worker, honouring `retry-after`, doubling up to 10 minutes.
- **Weekly quota:** when Euka says the quota is used up, nothing is called until Monday 00:00 UTC. The pause is saved to disk, so it survives restarts.
- **Market Intelligence fallbacks:**
  - Rate limited: it's paused for 30 minutes and Social Intelligence carries on alone.
  - Not available to the key (other 4xx): it's switched off for that run.
- **Saving:** results are written every 10 SKUs. Results for SKUs no longer in the products API are dropped when a batch starts.

**On the page:** hide a wrong match ("Not a match") or pin the right listing. Either one re-checks that SKU right away. Overrides are saved in `competitor-overrides.json`.

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
5. **Log:** every cell written goes to the [activity log](#activity-log) as an `EXCEL EDIT` line: SKU, column, cell, old value → new value, and the name the editor typed the first time they saved (kept in their browser).

**Setup:**

1. In the Microsoft Entra admin center, create an app registration.
2. Add the Microsoft Graph **application** permission `Files.ReadWrite.All`, grant admin consent, and create a client secret.
3. Set `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` in Render → Environment.

## Customer catalogs

There are three customer catalogs to start with, each at its own link with its own password: **Catalog 1** at `/catalog`, **Catalog 2** at `/catalog2` (no prices by default) and **Catalog 3** at `/catalog3`. **+ Add catalog** on Catalog management adds another at the next free number (`/catalog4`, …, up to 20), and **Remove catalog** deletes one with its settings, prices and password (at least one stays). A catalog can be given a name that only you see. Give a customer whichever link fits. They all share the page below; everything in this section applies to each, with its own settings.

`/catalog` is the wholesale catalog for customers (`lib/catalog.js`, `catalog/index.html`), laid out like `american_seair_imports_wholesale_2025.xlsx`: brand logos, address and phone, then SKU, UPC, name, category, piece price and case price with a picture of each product, grouped under red category headings (Perfumes, Air Freshner, Deodorant, Car Perfume, Incense, Sunglasses, then Diffusers, Cosmetics, Health & Beauty, Electronics). Customers can search and filter by category. One **Export** button opens a window to choose PDF or Excel and either the whole catalog (every listed product, by category) or only what's on screen; both files start with the company logo, brand logos, address and phone, like the printed price list. The page borrows the shared design system's tokens and components (buttons, inputs, lozenges) but keeps its own layout, always in the light theme.

- It reads the same products API as the dashboard (5-minute cache), so prices follow the API. Opened-box, deleted and discontinued SKUs are left out.
- The API has no selling price, only `cost` (the workbook's WHOLESALE COST) and `qty_in_case`. Each catalog applies its own wholesale rules, editable in Catalog management: piece price = cost + 12%, case price (per piece) = cost + 8% by default, both rounded up to the next $0.50 (also editable). A price set for a SKU replaces its piece price.
- Customers can switch between a list and a tile view, filter by category, type, price, new, photo or cart, and build an order in a cart. The cart lives only in their browser for 6 hours; "Copy order" puts it on the clipboard to text or email to sales.
- Stock: each product shows **In stock** (`live_qoh` > 0, on the shelf now), **Available to order** (`qoh` > 0 but not live) or **Ask us** (neither). Customers pick "In stock now" or "All products we carry" at the top; the choice also applies to downloads. Only the status leaves the server, never the counts.
- The API has no picture field, so pictures come from the Jomashop listing data in the API (`igloo_jomashop`), then NocNoc (`igloo_nocnoc`), then any other product with the same UPC, and last the picture on the hub storefront's product list (`/api/ecom/search`, matched by the QuickBooks item id, then SKU, then barcode; reloaded every 6 hours, URL in `HUB_IMAGES_API`). Products with none show "No photo". Pictures are served through `/catalog/img/<sku>`, which only fetches the URL found for that SKU.
- Customers sign in with the catalog's password (not the admin token). Sessions work like the dashboard's: 6 hours, tied to the browser, 10 wrong tries per 15 minutes per IP. Everyone, admins included, needs the catalog password: a dashboard sign-in doesn't open the catalog, and a catalog sign-in never opens the dashboard or `/api/*`.
- Only the catalog fields leave the server (`/catalog/data`); costs, vendors, stock and sales stay private.
- Clicking a product's picture opens a bigger view, with arrows to step through the products shown.
- The **Catalog management** page (`public/catalog-admin.html` + `public/js/catalog-admin.js`, admin sign-in) controls it: turn the catalog on or off, show or hide piece and case prices, set the pricing rules (piece and case markup, and what prices round up to), include every API product except the ones you untick or only the ones you tick, and set your own piece price for any SKU. Each catalog has its own settings and its own password, which can be set on that page (stored hashed; it overrides `CATALOG_PASSWORD` / `CATALOG<N>_PASSWORD` on Render, and changing it signs that catalog's customers out). Settings are saved to `catalog-settings.json` in `COMPETITOR_DATA_DIR` (or `CATALOG_DATA_DIR`), so keep that on the Render disk. Open catalogs pick up changes within a minute, and hidden prices are never sent to customers. API: `GET`/`POST /api/catalog/settings` (admin sign-in).

## Activity log

One plain-text file, `activity.log` in the data directory, with one line per event (`lib/activity.js`):

```
2026-10-15 04:03:29Z | CATALOG VISIT | Catalog 1 (/catalog) | 203.0.113.7 | Safari on iPhone
2026-10-15 04:05:12Z | CATALOG CHANGE | Catalog 2 (/catalog2): piece prices hidden → shown; unticked PER 101, PER 102 | 198.51.100.4 | Chrome on Windows
```

Fields: time (UTC) | event | details | IP address | browser and device. Passwords and tokens are never written; a password change shows only as "password changed".

| Event | When |
|---|---|
| `SIGN IN`, `SIGN IN FAILED`, `SIGN IN BLOCKED`, `SIGN OUT` | Dashboard sign-in with the admin token (blocked = 10 wrong tries in 15 minutes) |
| `REPORTS VISIT`, `CATALOG MANAGEMENT VISIT` | Someone signed in opens the reports page or Catalog management |
| `CATALOG SIGN IN`, `CATALOG SIGN IN FAILED`, `CATALOG SIGN IN BLOCKED`, `CATALOG SIGN OUT` | A customer signs in to a catalog |
| `CATALOG VISIT` | A signed-in customer opens a catalog |
| `CATALOG CHANGE` | A save on Catalog management, with every change from → to: name, on/off, prices shown or hidden, markups, rounding, which products, SKUs ticked or unticked, own prices per SKU, password changed |
| `CATALOG ADDED`, `CATALOG REMOVED` | A catalog is added or removed |
| `EXCEL EDIT` | One cell written to the workbook: SKU, column, cell, old → new, editor |
| `COMPETITOR OVERRIDE`, `COMPETITOR SEARCH` | A TikTok listing pinned, hidden or cleared; a batch of 100 searched, or a product re-checked |
| `SERVER START` | Each boot or deploy, with where files are saved |
| `LOG TRIMMED` | Old entries were deleted: past 90 days, or to stay under the size cap |

- **Visits are grouped:** the same person (IP and browser) opening the same page again within 15 minutes is one line, not one per refresh.
- **Retention:** entries older than 90 days (about 3 months, `ACTIVITY_LOG_DAYS`) are deleted when the server starts and every 6 hours after, so the file holds a rolling 3 months. The moment it passes 20 MB (`ACTIVITY_LOG_MAX_MB`), the oldest entries go first, so a flood of bad sign-ins can't fill the disk. Blocked sign-ins are logged once per IP and browser every 15 minutes. Each clean-up that drops anything writes a `LOG TRIMMED` line saying what went and why.
- **Reading it:** **Activity log** in the side navigation (`/activity.html`) shows the log's size against its cap ("0.9 MB of 20 MB"), and when the size cap last forced old entries out (or that it never has). Below that it shows the latest 500 entries (up to 2,000 with **Show more**), newest first, with search and an event filter. **Download log** saves the whole file.
- **IP address** is `CF-Connecting-IP` (set by Cloudflare in front of Render), else the first address in `X-Forwarded-For`. Someone on a VPN or mobile network shows that network's address.
- The file lives in `COMPETITOR_DATA_DIR`, so it survives deploys only on a Render persistent disk (see [Run it](#run-it)).

## API reference

All `/api/*` routes need an admin session or `x-admin-token`. Responses are JSON.

| Method and path | What it does |
|---|---|
| `GET /api/products` (`?refresh`) | The products API body as-is. Headers `x-fetched-at` (when the server fetched it) and `x-source` (`live` or `stale`). 502 when there's no copy at all. |
| `GET /api/session` | `{ expiresAt }` for the current browser session (null for header auth). |
| `GET /api/competitors` | Everything the tab needs: `configured, running, progress, runAt, finishedAt, errors, perSku, minScore, region, next{size, from, to, of, firstSku}, quotaUntil, saved, sources, marketIntel, skus{sku: {checkedAt, queries, calls, matches[], candidates[], error}}, overrides`. |
| `GET /api/competitors/status` | Checks the Euka key (`/me`, cached 10 minutes): `configured, keyOk, key, error, running, progress, lastCall`. |
| `POST /api/competitors/refresh` | No body: searches the next batch of 100 in the background (202). `{ "skus": [...] }` (up to 100): re-checks those; 3 or fewer waits and returns their results. 409 if a search is going. |
| `POST /api/competitors/override` | `{ sku, productId, action: "ignore" \| "pin" \| "clear" }`. Saves it and re-checks that SKU. The SKU must be in the products API; up to 50 pinned and 50 hidden listings per SKU. |
| `GET /api/excel` (`?refresh`) | Connection status, workbook name and link, header row, row count, columns. |
| `GET /api/excel/row?sku=` | `{ sku, row, sheet, cells: [{ col, header, label, value, text, editable, reason, formula? }] }`. 404 if not on the sheet, 409 if on two rows. |
| `POST /api/excel/edit` | `{ sku, editor, changes: [{ col, header, expected, value }] }` (up to 200). Returns `results` per cell with `ok` or `error`. |
| `GET /api/catalog/list` | `{ catalogs: [{ id, name, url, enabled }] }`, for the side navigation. |
| `POST /api/catalog/add` | Adds a catalog at the next free number; returns its `settings`. |
| `POST /api/catalog/remove` | `{ catalog }`. Deletes it and its settings (at least one stays). |
| `GET /api/activity` (`?q=`, `?limit=`, max 2000) | `{ entries: [{ at, event, details, ip, device }], days, persistent, file, sizeBytes, maxBytes, capHitAt }`, newest first, optionally only entries containing `q`. |
| `GET /api/activity/download` | The whole `activity.log` as a file. |
| `GET /api/catalog/settings` | Every catalog's settings (no password hashes), whether settings persist, and every product with its catalog fields. |
| `POST /api/catalog/settings` | `{ catalog: "<id>", name, enabled, showPrices, showCasePrices, pieceMarkupPct, caseMarkupPct, roundTo, mode: "all" \| "selected", hidden[], added[], prices{sku: price}, newPassword?, clearPassword? }`. |

Other routes:

| Path | Who | What |
|---|---|---|
| `GET /login`, `POST /login` (`token`, `next`), `GET /logout` | anyone | Admin sign-in |
| `/`, `/index.html`, `/catalog-admin.html`, `/activity.html`, `/js/*` | admin | Dashboard pages |
| `/css/*` | anyone | The shared stylesheet (the sign-in pages and catalog use it too) |
| `/catalog`, `/catalog2`, `/catalog3`, … | password | Catalog page or its sign-in |
| `POST /catalog/login` (`password`), `GET /catalog/logout` | anyone | Catalog sign-in (same under `/catalogN`) |
| `GET /catalog/data` | catalog session | Listed products with only catalog fields and stock status |
| `GET /catalog/img/<sku>` | catalog session | That SKU's picture, fetched through the server (images only, up to 8 MB, cached 1 day) |
| `/media/*`, `/healthz` | anyone | Logos and icon; health check |

## Saved files

Everything is written to the data directory: `COMPETITOR_DATA_DIR`, which defaults to `./data` and is git-ignored. Catalog settings can go elsewhere with `CATALOG_DATA_DIR`. Whole-file writes go to a `.tmp` file first and are then renamed, so a crash can't leave half a file; the activity log is appended to one line at a time.

| File | Written by | Holds |
|---|---|---|
| `competitors.json` | Competitor searches | Where the next batch starts, per-SKU matches and candidates, run times, quota pause, Market Intelligence state |
| `competitor-overrides.json` | Pin and Not a match | `{ sku: { ignore: [ids], pin: [ids] } }` |
| `catalog-settings.json` | Catalog management | Which catalogs exist (`_ids`) and each one's settings, including hashed passwords |
| `activity.log` | Sign-ins, visits, Catalog management changes, Excel edits, competitor pins | One line per event, last 90 days (see [Activity log](#activity-log)) |

None of them can grow without limit:

| File | Bound |
|---|---|
| `competitors.json` | One entry per SKU in the products API (others are dropped when a batch starts), each with at most 5 matches and 5 near misses. |
| `competitor-overrides.json` | Only SKUs in the products API, at most 50 pinned and 50 hidden listings each; a SKU with none left is removed. |
| `catalog-settings.json` | At most 20 catalogs, each with at most 10,000 SKUs per list and 10,000 own prices, SKUs up to 64 characters. |
| `activity.log` | 90 days and 20 MB, whichever comes first. Excel edit history lives here too, so it has the same bound. |

In memory, the sign-in limits, the rate limits and the "already logged this visit" list are all swept or capped, and the products, catalog and hub picture caches are replaced, not added to.

The products list is never written to disk on the server.

## Settings (environment variables)

All of these are in `.env.example`. Only `ADMIN_TOKEN` is required.

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_TOKEN` | (none) | Dashboard sign-in and `x-admin-token`. Nothing but the catalogs is served without it. |
| `SESSION_HOURS` | 6 | How long a dashboard sign-in lasts on one browser. |
| `PORT` | 3000 | Set by Render. |
| `PRODUCTS_API` | hub `/api/open/products` | The products feed. |
| `CATALOG_PASSWORD`, `CATALOG<N>_PASSWORD` | (none) | Catalog passwords (`CATALOG2_PASSWORD`, `CATALOG3_PASSWORD`, …). A password set in Catalog management overrides these. |
| `CATALOG_SESSION_HOURS` | `SESSION_HOURS` | How long a catalog sign-in lasts. |
| `CATALOG_NEW_DAYS` | 30 | Products added within this many days get the NEW tag. |
| `CATALOG_DATA_DIR` | `COMPETITOR_DATA_DIR` | Where catalog settings are saved. |
| `HUB_IMAGES_API` | hub `/api/ecom/search` | Storefront product list used for catalog pictures. |
| `EUKA_API_KEY` | (none) | Turns on TikTok competitors. |
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
| `COMPETITOR_BATCH_SIZE` | 100 | SKUs searched per click on **Search next 100**. |
| `COMPETITOR_MIN_SCORE` | 0.6 | Match threshold. |
| `OUR_TIKTOK_SHOP_NAMES` | (none) | Our shop names, left out of competitors. |
| `COMPETITOR_DATA_DIR` | `./data` | Data directory. Point it at the Render disk. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | (none) | Entra app for Excel write-back. |
| `EXCEL_FILE_URL` | (none) | Link to the workbook (takes precedence over user + path). |
| `EXCEL_USER` | `office@americanseairimports.onmicrosoft.com` | Workbook owner. |
| `EXCEL_PATH` | `TIKTOK PRICING 786110.xlsx` | Path in their OneDrive. |
| `EXCEL_SHEET` | `0. MASTER` | Sheet to edit. |
| `EXCEL_SKU_HEADER` | `SKU #` | Header of the SKU column. |
| `EXCEL_HEADER_ROW` | 0 (find it) | Header row number, if it shouldn't be detected. |
| `EXCEL_LOCKED_COLUMNS` | (none) | Columns (letters or headers) that stay read only. |
| `ACTIVITY_LOG_DAYS` | 90 | How many days of activity log are kept. |
| `ACTIVITY_LOG_MAX_MB` | 20 | Size cap for the activity log; the oldest entries go first. |
| `MS_GRAPH_BASE`, `MS_LOGIN_BASE` | Microsoft defaults | Override Graph and sign-in hosts. |

## What the browser stores

Only view preferences, plus the sign-in cookie (HttpOnly). No product data, costs or tokens. Older leftovers (`asi-admin-token`, `asi-minmargin`, `asi-platforms-v2` and the `asi-dashboard` IndexedDB copy) are deleted on every page load by `shell.js`.

| Key | Where | What |
|---|---|---|
| `asi-v4-state` | localStorage | Current view, planning period, platform, grouping, filters |
| `asi-v4-settings` | localStorage | The sheet's numbers (see Settings) |
| `asi-v4-hidden` | localStorage | Hidden columns in Product master and Items sold |
| `asi-theme` | localStorage | Light, dark or match device |
| `asi-editor` | localStorage | Your name for the Excel edit history |
| catalog cart | localStorage on the catalog page | A customer's cart, for 6 hours |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "The dashboard is locked" (503) | `ADMIN_TOKEN` isn't set on Render. |
| Everyone got signed out | `ADMIN_TOKEN` changed, the 6 hours ran out, or the browser's user agent changed (a browser update). |
| "Couldn't load the products API" | The upstream API is down or cutting responses off. The server falls back to its last good copy. Try **Refresh data** in a minute. Server logs show each attempt (`Products fetch attempt …`). |
| Data says "last good copy from …" | The server is serving its stale copy while the upstream fails. |
| Competitor results vanish after a deploy | `COMPETITOR_DATA_DIR` isn't on a persistent disk (the tab shows "Results reset when the server restarts"). |
| "Euka's weekly limit is used up" | Euka's quota resets Monday 00:00 UTC; click **Search next 100** after that. |
| "Market intelligence unavailable" | The key's plan lacks it, or it's rate limited. Product search carries on alone. |
| Excel section says not connected | Set the three `MS_*` variables. "Couldn't open the workbook" means the file path or permission is wrong. |
| Excel save says "changed in Excel since you opened it" | Someone edited that cell. Reopen the product to load the new value. |
| Catalog says it's locked | Set its password in Catalog management or on Render. |
| Catalog settings, passwords or the activity log reset after a deploy | No persistent disk: add one and set `COMPETITOR_DATA_DIR` (see [Run it](#run-it)). |
| "Cross-site request refused." (403) | A form or script on another site posted here. Use the dashboard's own pages. |
| Lots of `SIGN IN FAILED` from one IP in the activity log | Someone is guessing. After 10 tries they're blocked for 15 minutes. Change `ADMIN_TOKEN` or the catalog password if you're worried. |
