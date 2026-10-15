// Sign-in gate for the whole dashboard. Nothing but the sign-in page and /healthz is served without
// a valid session. Entering ADMIN_TOKEN starts a session for this browser that lasts SESSION_HOURS
// (6 by default) from sign-in, then asks again. Sessions are signed with a key derived from
// ADMIN_TOKEN, so changing the token on Render signs everyone out. Scripts can still call /api/*
// with an x-admin-token header. Sign-ins, failed sign-ins and sign-outs go to the activity log.
const crypto = require("crypto");
const activity = require("./activity");
const { readForm } = require("./http");

const COOKIE = "asi_session";
const HOURS = +(process.env.SESSION_HOURS || 6);
const token = () => (process.env.ADMIN_TOKEN || "").trim();
const key = () => crypto.createHash("sha256").update("asi-session:" + token()).digest();
const sign = data => crypto.createHmac("sha256", key()).update(data).digest("base64url");
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// Ties a session to the browser that signed in, so a copied cookie doesn't work on another device.
const device = req => sha(req.headers["user-agent"] || "").toString("base64url").slice(0, 16);
const PUBLIC_PATHS = new Set(["/login", "/logout", "/healthz", "/favicon.ico"]);

// Wrong passwords: 10 tries per IP per 15 minutes, then that IP waits. On top of that, 200 wrong tries from
// everyone together within 15 minutes pause all new sign-ins until the window ends, so guessing from many
// addresses at once gets nowhere (anyone already signed in stays in). One limiter for the dashboard and one
// shared by all catalogs (catalog.js). Old entries are swept, and the map can't outgrow the overall cap.
const WINDOW = 15 * 60e3, PER_IP = 10, OVERALL = 200;
function limiter() {
  const fails = new Map();
  let all = { n: 0, since: Date.now() };
  const fresh = f => f && Date.now() - f.since <= WINDOW;
  setInterval(() => { for (const [ip, f] of fails) if (!fresh(f)) fails.delete(ip); }, WINDOW).unref();
  return {
    blocked: ip => { const f = fails.get(ip); return (fresh(all) && all.n >= OVERALL) || (fresh(f) && f.n >= PER_IP); },
    fail: ip => {
      if (!fresh(all)) all = { n: 0, since: Date.now() };
      let f = fails.get(ip);
      if (!fresh(f)) fails.set(ip, f = { n: 0, since: Date.now() });
      f.n++; all.n++;
    },
    clear: ip => fails.delete(ip),
  };
}
const tries = limiter();

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function session(req) {
  const raw = cookies(req)[COOKIE];
  if (!raw || !token()) return null;
  const [data, sig] = raw.split(".");
  if (!data || !sig || !same(sig, sign(data))) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return s.exp > Date.now() && s.dev === device(req) ? s : null;
  } catch { return null; }
}
const secure = req => req.headers["x-forwarded-proto"] === "https";
function setSession(req, res) {
  const exp = Date.now() + HOURS * 3600e3;
  const data = Buffer.from(JSON.stringify({ exp, dev: device(req), id: crypto.randomBytes(9).toString("base64url") })).toString("base64url");
  res.setHeader("set-cookie", `${COOKIE}=${data}.${sign(data)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HOURS * 3600}${secure(req) ? "; Secure" : ""}`);
}
const clearSession = (req, res) =>
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? "; Secure" : ""}`);

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Only a path on this site: "//host" and "/\\host" would send the browser to another site after sign-in.
const safeNext = n => typeof n === "string" && /^\/(?![\/\\])/.test(n) && !/[\\\r\n]/.test(n) && !n.startsWith("/login") ? n : "/";
function loginPage(res, status, { next = "/", error = "" } = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Fragrance Wholesaler USA</title><link rel="icon" href="/media/favicon.svg"><link rel="stylesheet" href="/css/ads.css">
</head><body class="signin-page">
<form class="signin" method="post" action="/login">
  <span class="plate"><img src="/media/logo-fwusa.jpg" alt="Fragrance Wholesaler USA"></span>
  <h1>Business dashboard</h1>
  <p>Enter the admin token. You'll stay signed in on this device for ${HOURS} hours.</p>
  <input type="password" name="token" autocomplete="current-password" placeholder="Admin token" autofocus required>
  <input type="hidden" name="next" value="${esc(next)}">
  <button class="primary" type="submit">Sign in</button>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}
</form></body></html>`);
}

function tooMany(res) {
  res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(WINDOW / 1000) });
  res.end(JSON.stringify({ error: "Too many wrong tries. Wait 15 minutes and try again." }));
}

// Returns true when it answered the request (sign-in page, redirect or 401); false lets the request through.
async function gate(req, res, url) {
  const p = url.pathname;
  // Logos, the icon (media/) and the design system's stylesheet (css/) are public so sign-in pages and the
  // customer catalogs can use them. They hold nothing private.
  if (p === "/healthz" || p === "/favicon.ico" || p.startsWith("/media/") || p.startsWith("/css/")) return false;
  // The customer catalogs have their own passwords (catalog.js).
  if (/^\/catalog\d*(\/|$)/.test(p)) return false;                 // every customer catalog (/catalog, /catalog2, /catalog3, …)
  if (!token()) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The dashboard is locked: set ADMIN_TOKEN in Render → Environment to sign in.");
    return true;
  }
  if (p === "/logout") { if (session(req)) activity.log("SIGN OUT", "dashboard", req); clearSession(req, res); res.writeHead(302, { location: "/login" }); res.end(); return true; }
  if (p === "/login") {
    if (req.method === "POST") {
      const ip = activity.ipOf(req), form = await readForm(req), next = safeNext(form.next);
      if (tries.blocked(ip)) {
        activity.visit("SIGN IN BLOCKED", "dashboard: too many wrong tries", req);
        return loginPage(res, 429, { next, error: "Too many wrong tries. Wait 15 minutes and try again." }), true;
      }
      if (!same(String(form.token || "").trim(), token())) {
        tries.fail(ip); activity.log("SIGN IN FAILED", "dashboard: wrong admin token", req);
        return loginPage(res, 401, { next, error: "That token isn't right." }), true;
      }
      tries.clear(ip); setSession(req, res); activity.log("SIGN IN", "dashboard", req);
      res.writeHead(303, { location: next }); res.end(); return true;
    }
    if (session(req)) { res.writeHead(302, { location: safeNext(url.searchParams.get("next")) }); res.end(); return true; }
    return loginPage(res, 200, { next: safeNext(url.searchParams.get("next")) }), true;
  }
  const s = session(req), header = req.headers["x-admin-token"], ip = activity.ipOf(req);
  // A script's x-admin-token counts against the same wrong-try limit as the sign-in form.
  let headerOk = false;
  if (header && !s) {
    if (tries.blocked(ip)) return tooMany(res), true;
    headerOk = same(header, token());
    if (!headerOk) { tries.fail(ip); activity.log("SIGN IN FAILED", `dashboard: wrong x-admin-token on ${p}`, req); }
  }
  if (s || headerOk) {
    // A signed-in user is the admin, so the existing admin-only API calls don't ask for the token again.
    req.headers["x-admin-token"] = token();
    if (p === "/api/session") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ expiresAt: s ? new Date(s.exp).toISOString() : null }));
      return true;
    }
    return false;
  }
  if (p.startsWith("/api/")) {
    res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "Sign in required", login: "/login" }));
    return true;
  }
  if (PUBLIC_PATHS.has(p)) return false;
  res.writeHead(302, { location: "/login?next=" + encodeURIComponent(p + url.search), "cache-control": "no-store" });
  res.end();
  return true;
}

// Shared with catalog.js, which runs its own sign-in with the same rules.
module.exports = { gate, cookies, device, same, secure, esc, limiter };
