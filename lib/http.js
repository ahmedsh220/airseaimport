// Helpers shared by every request handler: reading a request body with a size cap, answering JSON, and
// per-IP rate limits.
const activity = require("./activity");

// The whole body as text. A body over max bytes is refused instead of being read into memory.
function readText(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size <= max) return chunks.push(c);
      reject(Object.assign(new Error("Request body too large"), { status: 413 }));
      req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function readJson(req, max = 1e5) {
  const text = await readText(req, max);
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error("Bad JSON"), { status: 400 }); }
}
// A sign-in form. An oversized or broken one reads as empty, which fails the password check.
const readForm = req => readText(req, 4096).then(t => Object.fromEntries(new URLSearchParams(t)), () => ({}));

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

// Requests per IP per minute, counted in one-minute windows. The counts are dropped when a window ends, and
// at most MAX_IPS addresses are tracked in one window (new ones past that are refused), so memory stays small.
const MAX_IPS = 20000;
function rateLimit(perMinute) {
  let hits = new Map(), since = Date.now();
  return req => {
    if (Date.now() - since >= 60e3) { hits = new Map(); since = Date.now(); }
    const ip = activity.ipOf(req);
    if (!hits.has(ip) && hits.size >= MAX_IPS) return true;
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    return n > perMinute;
  };
}

module.exports = { readJson, readForm, sendJson, rateLimit };
