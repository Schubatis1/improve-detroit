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

module.exports = async function handler(req, res) {
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

    // Vercel's default body parser gives us: a parsed object for JSON, or a
    // raw Buffer for anything else (including multipart/form-data image
    // uploads) -- Buffers/strings go straight through untouched so
    // multipart boundaries stay intact; JSON is re-serialized.
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined && req.body !== null) {
        body = Buffer.isBuffer(req.body) || typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body);
    }

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
};
