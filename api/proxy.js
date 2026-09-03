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
//
// This function ALSO holds the upstream API credentials. They used to live
// in config.js, which is committed to a public repo AND served verbatim to
// every visitor of the deployed site -- so the SeeClickFix token (which can
// file real tickets with the City of Detroit under this account) and the
// billable Plate Recognizer / Google Maps keys were readable by anyone.
// They're now Vercel environment variables, injected here per-host and
// never sent to the browser. See ALLOWED_HOSTS below for which credential
// goes to which host.
//
// Because this function now carries those credentials, it can't stay open
// to the public the way a plain CORS relay could -- otherwise anyone could
// still spend them, just indirectly (a confused deputy). Every request must
// therefore carry a Firebase ID token for the one authorized account; see
// requireAuthorizedUser below.
const admin = require('firebase-admin');

// Same account the Firestore/Storage rules and index.html's ALLOWED_EMAIL
// gate on -- this is a single-user app.
const ALLOWED_EMAIL = 'aschubatis@gmail.com';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'improve-detroit';

// How each allowed host is authenticated upstream:
//   inject  -- the proxy builds the Authorization header from an env var.
//   query   -- the proxy appends a credential to the query string.
//   forward -- the caller supplies the credential (see X-Upstream-Authorization).
//
// MailStream is 'forward' because its key legitimately has to be in the
// browser anyway: this app calls MailStream directly (that API does send
// CORS headers) and only falls back to this proxy on a transient network
// failure, so moving its key server-side here wouldn't take it out of the
// client. It's fetched at runtime from Firestore (config/secrets) rather
// than committed, which is what keeps it out of the public repo.
const ALLOWED_HOSTS = new Map([
    ['seeclickfix.com', { mode: 'inject', envVar: 'SEECLICKFIX_TOKEN', scheme: 'Bearer' }],
    ['api.platerecognizer.com', { mode: 'inject', envVar: 'PLATE_RECOGNIZER_API_KEY', scheme: 'Token' }],
    ['maps.googleapis.com', { mode: 'query', envVar: 'GOOGLE_MAPS_API_KEY', queryParam: 'key' }],
    ['my.mailstream.app', { mode: 'forward' }],
]);

// Only forwarded in each direction; everything else (host, content-length,
// connection, cookies, etc.) is stripped so upstream sees a clean request
// and the browser sees a clean response.
//
// Note that `authorization` is deliberately NOT in this list: on the way in
// it carries the CALLER's Firebase ID token (proxy auth, consumed here and
// never forwarded), and on the way out it's set from the env var for the
// target host. A caller that genuinely needs to supply its own upstream
// credential (MailStream) sends it as X-Upstream-Authorization instead, so
// the two can never be confused for one another.
const REQUEST_HEADERS_TO_FORWARD = ['content-type', 'accept', 'idempotency-key'];

// Opt-out of upstream credential injection, for the one endpoint that is
// known to work WITHOUT auth and has never been tested with it:
// SeeClickFix's undocumented transient_files upload (see
// uploadTransientFile in index.html). Proxy auth is still required -- this
// only suppresses the outbound Authorization header.
const ANONYMOUS_UPSTREAM_HEADER = 'x-upstream-anonymous';
const RESPONSE_HEADERS_TO_FORWARD = ['content-type'];

// verifyIdToken only needs the project id -- it validates the token's
// signature against Google's public certs, fetched over HTTPS. No service
// account credential is required (and none is available here); initializing
// with one would be strictly more privilege than this function should hold.
function firebaseApp() {
    return admin.apps.length ? admin.apps[0] : admin.initializeApp({ projectId: FIREBASE_PROJECT_ID });
}

// Resolves to the verified token payload, or throws with a `status` for the
// response code to send back.
async function requireAuthorizedUser(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer (.+)$/i.exec(header.trim());
    if (!match) {
        const err = new Error('Missing Firebase ID token (expected "Authorization: Bearer <token>")');
        err.status = 401;
        throw err;
    }

    let decoded;
    try {
        decoded = await admin.auth(firebaseApp()).verifyIdToken(match[1]);
    } catch (verifyErr) {
        const err = new Error(`Invalid Firebase ID token: ${verifyErr instanceof Error ? verifyErr.message : verifyErr}`);
        err.status = 401;
        throw err;
    }

    // Same two conditions as firestore.rules: the right account, and an
    // email Google has actually verified.
    if (decoded.email !== ALLOWED_EMAIL || decoded.email_verified !== true) {
        const err = new Error('Not authorized for this deployment');
        err.status = 403;
        throw err;
    }
    return decoded;
}

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

    const upstreamAuth = ALLOWED_HOSTS.get(parsed.hostname);
    if (!upstreamAuth) {
        res.status(403).json({ error: `Host not allowed: ${parsed.hostname}` });
        return;
    }

    // Checked before the body is read or anything is sent upstream, so an
    // unauthenticated caller can't even use this to generate traffic.
    try {
        await requireAuthorizedUser(req);
    } catch (err) {
        res.status(err.status || 401).json({ error: err.message });
        return;
    }

    const headers = {};
    for (const name of REQUEST_HEADERS_TO_FORWARD) {
        const value = req.headers[name];
        if (value) headers[name] = value;
    }

    const anonymousUpstream = req.headers[ANONYMOUS_UPSTREAM_HEADER] === '1';

    if (anonymousUpstream) {
        // Nothing to attach -- deliberately unauthenticated upstream.
    } else if (upstreamAuth.mode === 'inject') {
        const secret = process.env[upstreamAuth.envVar];
        if (!secret) {
            res.status(500).json({ error: `Server is missing the ${upstreamAuth.envVar} environment variable` });
            return;
        }
        headers.authorization = `${upstreamAuth.scheme} ${secret}`;
    } else if (upstreamAuth.mode === 'query') {
        const secret = process.env[upstreamAuth.envVar];
        if (!secret) {
            res.status(500).json({ error: `Server is missing the ${upstreamAuth.envVar} environment variable` });
            return;
        }
        // set() rather than append() -- a caller-supplied key for this
        // param is overwritten rather than duplicated.
        parsed.searchParams.set(upstreamAuth.queryParam, secret);
    } else if (upstreamAuth.mode === 'forward') {
        const supplied = req.headers['x-upstream-authorization'];
        if (supplied) headers.authorization = supplied;
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
