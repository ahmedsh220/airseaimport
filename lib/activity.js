// Activity log: one plain-text file, activity.log in the data directory, with a line for everything worth
// knowing about who came by and what changed. Sign-ins (and failed ones), catalog visits, visits to the
// reports and Catalog management pages, every Catalog management change (from what, to what), Excel
// write-backs and competitor pins. Each line is:
//
//   2026-10-15 04:03:29Z | CATALOG VISIT | Catalog 1 (/catalog) | 203.0.113.7 | Chrome on iPhone
//
// time (UTC) | event | details | IP address | browser and device. Passwords and tokens are never written.
// Entries older than ACTIVITY_LOG_DAYS (90, about 3 months) are dropped at boot and every 6 hours, and the
// oldest are dropped early if the file passes ACTIVITY_LOG_MAX_MB (20), so it never grows without limit.
// The admin reads it on the dashboard's Activity log page (public/activity.html) or downloads it there.
const fs = require("fs");
const path = require("path");

const DIR = process.env.COMPETITOR_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DIR, "activity.log");
const DAYS = Math.max(1, +(process.env.ACTIVITY_LOG_DAYS || 90));
const MAX_BYTES = Math.max(1, +(process.env.ACTIVITY_LOG_MAX_MB || 20)) * 1024 * 1024;
// A page opened again by the same person within this window is one visit, not one line per refresh.
const VISIT_GAP_MS = 15 * 60e3;

// "Chrome on Windows", "Safari on iPhone"… from the user agent. Unknown agents (scripts, bots) are kept short as-is.
function device(ua) {
  ua = String(ua || "");
  if (!ua) return "unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : null;
  if (/bot|crawl|spider|curl|wget|python|node|axios|go-http/i.test(ua) || !browser) return ua.slice(0, 80);
  return os ? `${browser} on ${os}` : browser;
}
// The visitor's address as Render passes it (the first X-Forwarded-For entry), else the socket's.
const ipOf = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim() || "unknown";
// One field can't break the line format: no line breaks or "|" inside it.
const field = s => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\|/g, "/").trim().slice(0, 2000);
const stamp = (d = new Date()) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");

// Current file size, kept up to date on every write so the size cap holds between the 6-hourly clean-ups
// (a flood of failed sign-ins can't grow the file past ACTIVITY_LOG_MAX_MB and fill the disk).
let size = 0;
try { size = fs.statSync(FILE).size; } catch {}

// Add one line. req (optional) supplies the IP and device. Never throws: logging must not break a request.
function log(event, details, req) {
  const who = req ? [ipOf(req), device(req.headers["user-agent"])] : ["server", "-"];
  const line = [stamp(), event, details, ...who].map(field).join(" | ") + "\n";
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(FILE, line); size += Buffer.byteLength(line); }
  catch (e) { console.warn(`Couldn't write the activity log: ${e.message}`); }
  if (size > MAX_BYTES) prune();
}

// Page visits and blocked sign-ins: at most one line per person (IP + device) per event every 15 minutes.
const lastVisit = new Map();
function visit(event, details, req) {
  const key = `${event}|${details}|${ipOf(req)}|${req.headers["user-agent"] || ""}`, now = Date.now();
  if (now - (lastVisit.get(key) || 0) < VISIT_GAP_MS) return;
  lastVisit.set(key, now);
  log(event, details, req);
}

const timeOf = line => Date.parse(line.slice(0, 20).replace(" ", "T"));
// Drop entries past the retention window, and the oldest ones if the file is over the size cap.
function prune() {
  for (const [k, t] of lastVisit) if (Date.now() - t > VISIT_GAP_MS) lastVisit.delete(k);
  let text;
  try { text = fs.readFileSync(FILE, "utf8"); } catch { size = 0; return; }
  size = Buffer.byteLength(text);
  const cutoff = Date.now() - DAYS * 864e5;
  let lines = text.split("\n").filter(l => l && timeOf(l) >= cutoff);
  let kept = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0), cut = 0;
  while (kept > MAX_BYTES * 0.8 && cut < lines.length) kept -= Buffer.byteLength(lines[cut++]) + 1;
  lines = lines.slice(cut);
  const next = lines.length ? lines.join("\n") + "\n" : "";
  if (next.length === text.length) return;
  try {
    fs.writeFileSync(FILE + ".tmp", next);
    fs.renameSync(FILE + ".tmp", FILE);
    size = Buffer.byteLength(next);
    console.log(`Activity log trimmed: kept ${lines.length} entries from the last ${DAYS} days`);
  } catch (e) { console.warn(`Couldn't trim the activity log: ${e.message}`); }
}

function start() {
  prune();
  setInterval(prune, 6 * 3600e3).unref();
  log("SERVER START", process.env.COMPETITOR_DATA_DIR ? `saving to ${DIR}` : `saving to ${DIR}, which is wiped on every deploy unless it's on a persistent disk`);
}

// Entries newest first, optionally only those containing q (any field, any case).
function read({ q = "", limit = 500 } = {}) {
  let text = "";
  try { text = fs.readFileSync(FILE, "utf8"); } catch {}
  const needle = q.toLowerCase(), out = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i] || (needle && !lines[i].toLowerCase().includes(needle))) continue;
    const [at, event, details, ip, dev] = lines[i].split(" | ");
    out.push({ at, event, details, ip, device: dev });
  }
  return out;
}

// Dashboard side, behind the admin sign-in (auth.gate covers /api/*).
//   GET /api/activity?q=&limit=   latest entries, newest first (up to 2000)
//   GET /api/activity/download    the whole file, as activity.log
function handle(req, res, url) {
  if (url.pathname === "/api/activity") {
    const limit = Math.min(2000, Math.max(1, +url.searchParams.get("limit") || 500));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ entries: read({ q: url.searchParams.get("q") || "", limit }), days: DAYS, persistent: !!process.env.COMPETITOR_DATA_DIR, file: FILE }));
    return true;
  }
  if (url.pathname === "/api/activity/download") {
    let text = "";
    try { text = fs.readFileSync(FILE, "utf8"); } catch {}
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-disposition": 'attachment; filename="activity.log"' });
    res.end(text);
    return true;
  }
  return false;
}

module.exports = { log, visit, start, handle, ipOf };
