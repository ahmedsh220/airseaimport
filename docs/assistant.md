# Dashboard assistant: MCP server and chat (plan)

Status: **planned, not built yet.** This is the design to agree on before any code lands. Nothing described here runs today.

## Goal

Ask plain questions about the dashboard's data from inside the dashboard ("what should I reorder from Lux this week?", "which TikTok listings are we priced above every competitor on?", "how did Walmart do over the last 60 days?") and get answers that match what the tabs show, without handing the model, or anyone using it, the raw product feed.

Two pieces:

1. **Our own MCP server** (`lib/assistant/`): a small set of read-only tools over the data the server already loads (products API, Euka competitors, TikTok sales, catalog settings). MCP is the standard way to give a model tools, so the same server can later be plugged into ChatGPT, Claude or another agent without rewriting the tools.
2. **A chat panel in the dashboard** (`public/js/assistant.js`): a side panel that sends the question to our server, which runs the model and the tools and streams back the answer. The browser never talks to the model provider and never sees an API key.

## How it fits

```
Browser (signed in)                     Render web service (server.js)
┌───────────────────┐  POST /api/assistant/chat   ┌─────────────────────────────────────────┐
│ Assistant panel   │ ──────────────────────────► │ auth.gate (admin session, same as today)│
│ public/js/        │ ◄── streamed answer (SSE) ── │ lib/assistant/chat.js   model loop       │
│ assistant.js      │                             │   │ calls tools in-process (no hop)     │
└───────────────────┘                             │   ▼                                     │
                                                  │ lib/assistant/tools.js  read-only tools │
External MCP client (optional, off by default)    │   │ productList(), competitors, sales    │
┌───────────────────┐  POST /mcp (MCP_TOKEN)       │   ▼                                     │
│ ChatGPT / Claude  │ ──────────────────────────► │ lib/assistant/mcp.js   MCP transport    │
└───────────────────┘                             └─────────────────────────────────────────┘
                                                            │ HTTPS, key stays on server
                                                            ▼
                                                   Model provider (OpenAI or Anthropic)
```

- The chat route lives under `/api/`, so `lib/auth.js` already guards it: a dashboard session (6 hours, tied to the browser) or `x-admin-token`. Catalog sign-ins never reach it.
- The tools call the same in-memory `productList()` the dashboard and catalog use, so asking a question never adds a call to the slow upstream API.
- `/mcp` is a separate door for outside agents. It is off unless `MCP_TOKEN` is set, uses its own token (never `ADMIN_TOKEN`), and exposes the same tools with the same limits.

### One set of numbers

Today every metric (days of stock, reorder quantity, stock value, platform P&L, TikTok floor) is computed in the browser in `public/index.html` (`enrich`, `computePL`, `PL`, `CHANNELS`, `VENDORS`). If the assistant re-implemented them on the server, its answers would drift from the tabs. Step 1 of the build moves that code, unchanged, into `public/js/metrics.js`, loaded by the page as a script and by the server with `require`. The page's per-browser settings (sales window 80 days, order multiplier 45, trigger 28 days, minimum margin 18%, misc $0.05) travel with each chat request, so the assistant answers with the settings on screen.

## Tools (v1)

All tools are read-only. Each returns a small, shaped result, never the API rows themselves.

| Tool | Answers | Returns |
|---|---|---|
| `inventory_summary` | "How much stock do we have?" | The Overview tiles as numbers: projected sales for a period, reorder now (count, cases, cost), runs out within the period, out of stock but still selling, stock value and units on hand. Optional platform, category, tier or vendor filter. |
| `find_products` | "Do we carry Khamrah?" | Up to 10 matches: SKU, name, category, tier, on hand, 90-day sold, days of stock. |
| `product_detail` | "Tell me about PER1139." | One SKU: stock, sales by channel, our cost, best vendor quote, platform prices and profit, reorder status. |
| `reorder_list` | "What should I order from Lux?" | SKUs past the reorder trigger: order quantity, cases, order cost. Filter by vendor or channel. Up to 25 rows plus totals. |
| `top_sellers` | "Top sellers on Walmart?" | Top N (max 25) by 60-day units for a channel or overall. |
| `dead_and_overstock` | "Where is cash tied up?" | Stock beyond the cover target and dead stock, with value. Up to 25 rows plus totals. |
| `channel_mix` | "How is each platform doing?" | 60-day units, revenue and profit per channel, from the P&L rules. Aggregates only. |
| `vendor_savings` | "Where are we overpaying?" | SKUs where another vendor quotes below our cost, with the saving. Up to 25 rows plus total. |
| `tiktok_competitors` | "Where are we undercut on TikTok?" | Per SKU or summary: our price, competitor low/median/high, gap, suggested price. |
| `tiktok_sales` | "TikTok sales last 7 days?" | Our 7/14/30/60/90-day TikTok totals and top items from Euka. |
| `data_status` | "Is this data fresh?" | When the products API and competitor data were last loaded. |

Not tools, on purpose: Excel write-back, competitor pin/ignore, catalog settings changes, refreshes, CSV export, catalog passwords, and anything from `qb_customer_sales` (customer names). Write actions can be a later phase, each behind a confirm button in the panel, never something the model does on its own.

## Keeping business data safe

The rules the build follows, in order of importance:

1. **Same lock as the dashboard.** Chat is only reachable with a dashboard session or `x-admin-token`. The external `/mcp` door is off by default and has its own token, so it can be turned off or rotated without signing anyone out.
2. **Read-only.** No tool can change anything, send email, fetch a URL or reach the internet. A tool can only read what the server already holds.
3. **Small answers, not exports.** Every list tool caps rows (10 to 25) and returns totals for the rest. There is no "give me everything" tool, so a chat can't be used to dump the catalog, every cost or every vendor quote. Per-SKU detail is one SKU per call.
4. **Field allow-list.** Tools build their results from a named list of fields. Customer names (`qb_customer_sales`), raw listing JSON (`igloo_*`, `platform_updates`), internal ids and notes are never included. `ASSISTANT_HIDE` can hide more (for example vendor names) without code changes.
5. **Keys stay on the server.** The model key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) is only in Render → Environment. The browser talks to our server only.
6. **Provider data terms.** API traffic to OpenAI and Anthropic is not used for training by default. For extra cover, ask the provider for zero data retention on the account (OpenAI's "Private Intelligence" tier, or Anthropic's ZDR agreement).
7. **Untrusted text stays data.** Product names, notes and Euka listing titles come from outside and could contain instructions. The system prompt says tool results are data, the tools can't act on anything, and the panel renders answers as plain text with no images or auto-loading links, so a crafted product name can't make the page send data elsewhere.
8. **Limits and a log.** Per-session rate limit (20 questions per 10 minutes by default), a cap on tool calls per question (8) and on tokens per answer, and a log line per question in `assistant-log.jsonl` in the data dir: time, question, tools called and how many rows each returned (not the data itself). Readable at `GET /api/assistant/log`.

## Model choice

The user asked about OpenAI's new live agent. What that is today (October 2026):

- **Dots** (announced at OpenAI DevDay, 29 Sept 2026) are always-on agents inside ChatGPT, running GPT-6 Astra on their own cloud computer, for Pro and Business Premium plans. They live in ChatGPT, not in our page: there is no documented way to embed a Dot in the dashboard, and it would see data through whatever we connect to it. So a Dot is not the in-dashboard chatbot. It could become an **outside client** of our `/mcp` door later, if OpenAI lets Dots use custom MCP servers.
- **GPT-6.1 Sol** is OpenAI's new API workhorse model (OpenAI says close to Astra on agentic work at about a fifth of the price). This is the OpenAI model that would actually power our chat panel, through the Responses or Agents API with our tools.
- **gpt-realtime** (Realtime API) is OpenAI's live voice model with tool calling and MCP support. It is what "talk to the dashboard" would use, if voice is wanted later.
- **Claude Sonnet 5.5** (`claude-sonnet-5-5`, Anthropic) is the equivalent option on the Anthropic side, strong at tool use over structured data.

Recommendation: build the chat loop with a thin provider adapter (`AI_PROVIDER=openai|anthropic`) and **start with GPT-6.1 Sol**, since trying OpenAI is what was asked. The tools and MCP server don't change between providers, so switching is one environment variable, and both can be compared on the same questions before settling. Voice (gpt-realtime) and connecting a Dot to `/mcp` are later phases.

## Build phases

1. **Shared metrics.** Move the metric code from `public/index.html` into `public/js/metrics.js`; the page behaves exactly as before.
2. **Tools.** `lib/assistant/tools.js` with the v1 tools, field allow-list and row caps, plus tests that run each tool against `products-sample.json` and check caps and hidden fields.
3. **Chat route.** `POST /api/assistant/chat`, streamed with server-sent events, provider adapter, rate limit, log.
4. **Chat panel.** "Ask" button in the top bar opens a side panel: question box, streamed answer, which tools were used, and a link that opens the matching tab or product.
5. **MCP door.** `/mcp` (streamable HTTP, official MCP SDK), off unless `MCP_TOKEN` is set.
6. **Later, if wanted:** voice with gpt-realtime; write actions behind confirm buttons; a Dot or Claude connected to `/mcp`.

This adds the first npm dependencies to the project (the provider SDK and `@modelcontextprotocol/sdk`). Render installs them on deploy.

## Settings (planned)

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `openai` | `openai` or `anthropic`. |
| `OPENAI_API_KEY` | | Needed when the provider is OpenAI. |
| `OPENAI_MODEL` | GPT-6.1 Sol | Model id for OpenAI. |
| `ANTHROPIC_API_KEY` | | Needed when the provider is Anthropic. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model id for Anthropic. |
| `ASSISTANT_ENABLED` | `1` when a key is set | `0` hides the panel and closes the route. |
| `ASSISTANT_MAX_ROWS` | `25` | Most rows any tool returns. |
| `ASSISTANT_RATE` | `20/10m` | Questions per session per window. |
| `ASSISTANT_HIDE` | | Extra fields to keep out of every tool result, comma separated. |
| `MCP_TOKEN` | | Turns on `/mcp` for outside agents. Separate from `ADMIN_TOKEN`. |

These go into `.env.example` with the code, not before.

## Open questions

- Should vendor names and vendor quotes be visible to the assistant? The plan says yes (they're on the Vendors tab already); `ASSISTANT_HIDE` can turn them off.
- Is the external `/mcp` door wanted at all for v1, or only the in-dashboard chat?
- Voice: worth a phase, or text only?
