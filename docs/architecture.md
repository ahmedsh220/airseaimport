# Architecture

One Node web service (`server.js`, plain `http`, no framework, no npm dependencies) on Render. Every request goes through the sign-in gate first, then to the first module that claims the path.

## Request flow

```
request ─► auth.gate ─► /api/products ─► catalog.handle ─► catalog.handleAdmin ─► competitors.handle ─► excel.handle ─► tiktokSales.handle ─► static files
           lib/auth.js   server.js        lib/catalog.js                            lib/competitors.js   lib/excel.js    lib/tiktok-sales.js   public/, media/
```

## Sign-in

| Who | How | Reaches |
|---|---|---|
| Admin in a browser | `ADMIN_TOKEN` on `/login` starts a signed cookie session, tied to the browser, for `SESSION_HOURS` (6) | Dashboard pages and all of `/api/*` |
| Scripts | `x-admin-token` header | `/api/*` |
| Catalog customers | `CATALOG_PASSWORD` / `CATALOG2_PASSWORD` (or the hashed one set in Catalog management) | `/catalog*` and `/catalog2*` only |
| Anyone | nothing | `/healthz`, `/media/`, the sign-in pages |

Wrong tokens and passwords are limited to 10 tries per 15 minutes per IP. Changing `ADMIN_TOKEN` signs every admin out. Without `ADMIN_TOKEN` the dashboard serves nothing.

## Data sources

| Source | Module | Cached | Used by |
|---|---|---|---|
| Products API (`PRODUCTS_API`) | `server.js` | In memory; refreshed in the background when older than 5 minutes; fetched over HTTP/2 with HTTP/1.1 retries | Dashboard, catalogs, competitor checks |
| Euka social and market intelligence | `lib/competitors.js` | `competitors.json` in the data dir; full check on boot and every 12 hours | TikTok competitors tab |
| Euka TikTok Shop analytics | `lib/tiktok-sales.js` | In memory, 60 minutes | 7/14/30/60/90-day TikTok sales |
| Pricing workbook in OneDrive (Microsoft Graph) | `lib/excel.js` | Read per request | Excel section of a product's detail view; write-back |
| Hub storefront product pictures (`HUB_IMAGES_API`) | `lib/catalog.js` | In memory, 6 hours | Catalog pictures |

The dashboard's metrics (day average, days of stock, reorder quantity, stock value, platform P&L) are computed in the browser in `public/index.html` (`enrich`, `computePL`). The assistant plan moves them into a shared file so the server can use the same math; see [assistant.md](assistant.md).

## Routes

| Route | Auth | What |
|---|---|---|
| `GET /api/products` (`?refresh`) | admin | Products API passthrough |
| `GET /api/session` | admin | When the current session expires |
| `GET /api/competitors`, `/status`; `POST /refresh`, `/override` | admin | Competitor results and controls |
| `GET /api/tiktok-sales` | admin | Our TikTok Shop sales by window |
| `GET /api/excel`, `/row?sku=`, `/log`; `POST /edit` | admin | Workbook status, a SKU's row, edit log, write-back |
| `GET`/`POST /api/catalog/settings` | admin | Catalog settings |
| `/catalog`, `/catalog2` and below | catalog password | Customer catalogs (`/data`, `/img/<sku>`) |
| `/healthz` | none | Health check |

## Saved files

Everything is written to the data dir (`COMPETITOR_DATA_DIR`, defaulting to `./data`, which is git-ignored). On Render, point it at a persistent disk such as `/var/data` or the files are lost on each deploy.

| File | Written by |
|---|---|
| `competitors.json`, `competitor-overrides.json` | Competitor checks, pin and ignore |
| `catalog-settings.json` | Catalog management (includes hashed catalog passwords) |
| `excel-edits.jsonl` | Every Excel write-back |

## Secrets

All keys live in Render → Environment and are only read on the server: `ADMIN_TOKEN`, catalog passwords, `EUKA_API_KEY`, `MS_CLIENT_SECRET`. No key is sent to the browser. See `.env.example` for every setting.
