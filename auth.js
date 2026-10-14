// Sign-in gate for the whole dashboard. Nothing but the sign-in page and /healthz is served without
// a valid session. Entering ADMIN_TOKEN starts a session for this browser that lasts SESSION_HOURS
// (6 by default) from sign-in, then asks again. Sessions are signed with a key derived from
// ADMIN_TOKEN, so changing the token on Render signs everyone out. Scripts can still call /api/*
// with an x-admin-token header.
const crypto = require("crypto");

const COOKIE = "asi_session";
const HOURS = +(process.env.SESSION_HOURS || 6);
const token = () => (process.env.ADMIN_TOKEN || "").trim();
const key = () => crypto.createHash("sha256").update("asi-session:" + token()).digest();
const sign = data => crypto.createHmac("sha256", key()).update(data).digest("base64url");
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// Ties a session to the browser that signed in, so a copied cookie doesn't work on another device.
const device = req => sha(req.headers["user-agent"] || "").toString("base64url").slice(0, 16);
const PUBLIC_PATHS = new Set(["/login", "/logout", "/healthz", "/favicon.svg", "/favicon.ico"]);

// Failed sign-ins per IP: 10 tries per 15 minutes.
const fails = new Map();
const ipOf = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function limited(ip) {
  const f = fails.get(ip);
  if (f && Date.now() - f.since > 15 * 60e3) { fails.delete(ip); return false; }
  return !!f && f.n >= 10;
}
const failed = ip => { const f = fails.get(ip) || { n: 0, since: Date.now() }; f.n++; fails.set(ip, f); };

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
const safeNext = n => typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/";
function loginPage(res, status, { next = "/", error = "" } = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Air Sea Import</title><link rel="icon" href="/favicon.svg">
<style>
  :root { --bg: #f6f7f9; --panel: #fff; --text: #14181f; --muted: #5d6675; --border: #dde1e7; --accent: #2563eb; --bad: #c52a2a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1216; --panel: #171b21; --text: #e7eaee; --muted: #98a1ae; --border: #2a303a; --accent: #5b8cff; --bad: #f06a6a; } }
  * { box-sizing: border-box; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; padding: 16px; }
  form { width: 100%; max-width: 360px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
  input { width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  button { width: 100%; margin-top: 12px; padding: 9px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .err { color: var(--bad); margin: 10px 0 0; font-size: 13px; }
</style></head><body>
<form method="post" action="/login">
  <h1>Air Sea Import · Reports</h1>
  <p>Enter the admin token. You'll stay signed in on this device for ${HOURS} hours.</p>
  <input type="password" name="token" autocomplete="current-password" placeholder="Admin token" autofocus required>
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Sign in</button>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}
</form></body></html>`);
}
const readForm = req => new Promise(resolve => {
  let b = ""; req.on("data", c => { b += c; if (b.length > 4096) req.destroy(); });
  req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(b)))); req.on("error", () => resolve({}));
});

// Returns true when it answered the request (sign-in page, redirect or 401); false lets the request through.
async function gate(req, res, url) {
  const p = url.pathname;
  if (p === "/healthz" || p === "/favicon.svg" || p === "/favicon.ico") return false;
  // The customer catalogs have their own passwords (catalog.js).
  if (p === "/catalog" || p.startsWith("/catalog/") || p === "/catalog2" || p.startsWith("/catalog2/")) return false;
  if (!token()) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The dashboard is locked: set ADMIN_TOKEN in Render → Environment to sign in.");
    return true;
  }
  if (p === "/logout") { clearSession(req, res); res.writeHead(302, { location: "/login" }); res.end(); return true; }
  if (p === "/login") {
    if (req.method === "POST") {
      const ip = ipOf(req), form = await readForm(req), next = safeNext(form.next);
      if (limited(ip)) return loginPage(res, 429, { next, error: "Too many wrong tries. Wait 15 minutes and try again." }), true;
      if (!same(String(form.token || "").trim(), token())) { failed(ip); return loginPage(res, 401, { next, error: "That token isn't right." }), true; }
      fails.delete(ip); setSession(req, res);
      res.writeHead(303, { location: next }); res.end(); return true;
    }
    if (session(req)) { res.writeHead(302, { location: safeNext(url.searchParams.get("next")) }); res.end(); return true; }
    return loginPage(res, 200, { next: safeNext(url.searchParams.get("next")) }), true;
  }
  const s = session(req), header = req.headers["x-admin-token"];
  if (s || (header && same(header, token()))) {
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
module.exports = { gate, cookies, device, same, secure, esc, readForm, ipOf };
