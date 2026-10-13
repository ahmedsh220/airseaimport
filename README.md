# airseaimport

Single-page reports dashboard for the product data at
`https://hub.fragrancewholesalerusa.com/api/open/products`.

Open `index.html` in a browser (or host it on GitHub Pages). It fetches the API on load and builds:

- KPI tiles: SKUs, units on hand, inventory value, 90-day sales, stockouts, low stock, dead stock, on order, return rate, September revenue/margin
- Charts: 60-day sales by channel, top 15 sellers, stock health (days of cover), cheapest-vendor wins
- Report tables (sortable, searchable, CSV export): Reorder, Top sellers, Vendor pricing, Dead stock, Channel mix, Returns, All products

If the browser blocks the API call (CORS), save the API response as a `.json` file and use **Load JSON file**.

Assumptions: on hand uses `live_qoh` (falls back to `qoh`); cost uses `actual_cost` (then `cost`, `purchase_cost`); vendor columns (`lux`, `edge`, `tahir`, …) are treated as each vendor's unit price.
