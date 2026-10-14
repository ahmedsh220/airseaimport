# airseaimport

Single-page reports dashboard for the product data at
`https://hub.fragrancewholesalerusa.com/api/open/products`.

`npm start` (or `yarn start`) runs `server.js`, which serves `public/index.html` and proxies the API at `/api/products` (60s cache) so the browser never hits CORS. Deployed on Render as a Node web service. The page builds:

- KPI tiles: SKUs, units on hand, inventory value, 90-day sales, stockouts, low stock, dead stock, on order, return rate, September revenue/margin
- Charts: 60-day sales by channel, top 15 sellers, stock health (days of cover), cheapest-vendor wins
- Report tables (sortable, searchable, CSV export): Reorder, Top sellers, Vendor pricing, Dead stock, Channel mix, Returns, All products

A sticky filter bar picks the date field and range (default: today), category and tier. KPI tiles and chart bars open the matching report. Click any product for its full vendor price comparison. **Load JSON file** still works for offline snapshots.

Data notes: on hand uses `live_qoh`; our cost is `actual_cost` when above 0, else `cost`; vendor columns (`lux`, `edge`, `tahir`, …) are supplier prices; `*_60_days` are 60-day sales projections per channel; `sales_sep_sale_price` and `sales_sep_shipping_price_we_paid` are September totals.

## TikTok competitors (Euka)

The **TikTok competitors** tab compares each SKU's TikTok price with up to 5 same-item TikTok Shop listings found through [Euka's OpenAPI](https://server.euka.ai/docs) (`GET /social-intelligence/products`).

Setup: set `EUKA_API_KEY` in Render → Environment (all options are in `.env.example`). The server then checks every SKU in the products API on boot and every 12 hours (`competitors.js`), and saves the results in `COMPETITOR_DATA_DIR`.

How matching works: each product name is cleaned (sizes and words like EDP, spray, for women are dropped) and searched in Euka. Then every result is scored by how many of our name's words its title contains. A different size caps the score below the match threshold, and decants, samples and sets are marked down. Our own listings (`tiktok_product_id`) are excluded. In a product's detail view you can hide a wrong match or pin the right listing, and that SKU re-checks right away.

The tab shows our price, the competitors' lowest, median and highest prices, the gap, competitor and our 30-day units, profit at the lowest price using the sheet's TikTok rule, a margin floor price, and a suggested price: a cent under the cheapest competitor, but never below the floor.

API: `GET /api/competitors` returns results, `GET /api/competitors/status` checks the key, `POST /api/competitors/refresh` (`{ "skus": [...] }` is optional) and `POST /api/competitors/override` (`{ sku, productId, action: "ignore" | "pin" | "clear" }`) need `x-admin-token` when `ADMIN_TOKEN` is set.
