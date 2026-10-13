# airseaimport

Single-page reports dashboard for the product data at
`https://hub.fragrancewholesalerusa.com/api/open/products`.

`npm start` (or `yarn start`) runs `server.js`, which serves `public/index.html` and proxies the API at `/api/products` (60s cache) so the browser never hits CORS. Deployed on Render as a Node web service. The page builds:

- KPI tiles: SKUs, units on hand, inventory value, 90-day sales, stockouts, low stock, dead stock, on order, return rate, September revenue/margin
- Charts: 60-day sales by channel, top 15 sellers, stock health (days of cover), cheapest-vendor wins
- Report tables (sortable, searchable, CSV export): Reorder, Top sellers, Vendor pricing, Dead stock, Channel mix, Returns, All products

A sticky filter bar picks the date field and range (default: today), category and tier. KPI tiles and chart bars open the matching report. Click any product for its full vendor price comparison. **Load JSON file** still works for offline snapshots.

Data notes: on hand uses `live_qoh`; our cost is `actual_cost` when above 0, else `cost`; vendor columns (`lux`, `edge`, `tahir`, …) are supplier prices; `*_60_days` are 60-day sales projections per channel; `sales_sep_sale_price` and `sales_sep_shipping_price_we_paid` are September totals.
