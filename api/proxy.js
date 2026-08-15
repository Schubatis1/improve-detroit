// First-party replacement for the third-party corsproxy.io dependency.
// SeeClickFix, Plate Recognizer, and (occasionally) MailStream don't send
// CORS headers, so a browser fetch straight from improve-detroit.vercel.app
// gets blocked. Routing those calls through this same-origin function
// sidesteps CORS entirely -- the browser only ever talks to our own domain
// -- and drops the free/rate-limited corsproxy.io as a point of failure.
//
// Only proxies to the exact hosts this app actually calls -- an open
// `?url=<anything>` relay would let anyone use this deployment to make
// server-side requests to arbitrary targets on our dime.
const ALLOWED_HOSTS = new Set([
    'seeclickfix.com',
    'api.platerecognizer.com',
    'my.mailstream.app',
]);

// Only forwarded in each direction; everything else (host, content-length,
// connection, cookies, etc.) is stripped so upstream sees a clean request
// and the browser sees a clean response.
const REQUEST_HEADERS_TO_FORWARD = ['authorization', 'content-type', 'accept', 'idempotency-key'];
const RESPONSE_HEADERS_TO_FORWARD = ['content-type'];

// Vercel's automatic body parser only understands application/json,
// application/x-www-form-urlencoded, and text/plain -- for anything else
// (crucially, multipart/form-data image uploads) it leaves req.body
// undefined rather than handing back a raw Buffer. Relying on req.body
// here meant every multipart POST (SeeClickFix issue creation, Plate
// Recognizer lookups) was forwarded upstream with a valid
// Content-Type/boundary header but an empty body -- Plate Recognizer
// reported its file field as empty, and SeeClickFix's Rack parser choked
// on a boundary with nothing behind it and returned a generic HTML 400.
// Disabling the built-in parser and reading the raw stream ourselves
// forwards every content type byte-for-byte, no special-casing needed.
async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

async function handler(req, res) {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        res.status(400).json({ error: 'Missing "url" query parameter' });
        return;
    }

    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        res.status(400).json({ error: 'Invalid "url" parameter' });
        return;
    }

    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        res.status(403).json({ error: `Host not allowed: ${parsed.hostname}` });
        return;
    }

    const headers = {};
    for (const name of REQUEST_HEADERS_TO_FORWARD) {
        const value = req.headers[name];
        if (value) headers[name] = value;
    }

    const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readRawBody(req);

    let upstream;
    try {
        upstream = await fetch(parsed.toString(), { method: req.method, headers, body });
    } catch (err) {
        res.status(502).json({ error: `Upstream request failed: ${err instanceof Error ? err.message : err}` });
        return;
    }

    for (const name of RESPONSE_HEADERS_TO_FORWARD) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
    }
    res.status(upstream.status);
    res.send(Buffer.from(await upstream.arrayBuffer()));
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
