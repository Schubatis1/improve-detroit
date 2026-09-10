// Unit tests for api/proxy.js -- the gateway that holds the SeeClickFix /
// Plate Recognizer / Google Maps credentials and is supposed to be the ONLY
// thing standing between the public internet and those billable/sensitive
// keys (see api/proxy.js's own header comment). Everything here calls the
// exported handler directly with mock req/res objects and a stubbed
// firebase-admin/fetch -- no real network or Firebase project needed.
// firebase-admin's top-level `auth`/`apps`/`initializeApp` are getter-only
// accessors inherited from its internal FirebaseNamespace prototype (not
// plain own properties), so a plain `admin.auth = vi.fn()` throws ("has
// only a getter"). Object.defineProperty adds an own property on the
// `admin` object itself, which shadows the inherited getter -- that's the
// same real module object api/proxy.js requires (Node's CJS require cache
// is keyed by resolved path, so both requires return the identical
// object), so patching it here reaches every call site.
const admin = require('firebase-admin');

function patchAdmin({ verifyIdToken }) {
    Object.defineProperty(admin, 'apps', { value: [], configurable: true, writable: true });
    Object.defineProperty(admin, 'initializeApp', { value: vi.fn(() => ({})), configurable: true, writable: true });
    Object.defineProperty(admin, 'auth', { value: vi.fn(() => ({ verifyIdToken })), configurable: true, writable: true });
}

const verifyIdTokenMock = vi.fn();
patchAdmin({ verifyIdToken: verifyIdTokenMock });

const handler = require('../api/proxy.js');

function makeReq({ method = 'GET', url, headers = {}, bodyChunks = [] } = {}) {
    return {
        method,
        query: { url },
        headers,
        async *[Symbol.asyncIterator]() {
            for (const chunk of bodyChunks) yield Buffer.from(chunk);
        },
    };
}

function makeRes() {
    const res = {
        statusCode: undefined,
        headers: {},
        body: undefined,
        status: vi.fn(function status(code) { res.statusCode = code; return res; }),
        json: vi.fn(function json(payload) { res.body = payload; return res; }),
        send: vi.fn(function send(payload) { res.body = payload; return res; }),
        setHeader: vi.fn(function setHeader(name, value) { res.headers[name] = value; return res; }),
    };
    return res;
}

const VALID_TOKEN_USER = { email: 'aschubatis@gmail.com', email_verified: true };

beforeEach(() => {
    verifyIdTokenMock.mockReset();
    process.env.SEECLICKFIX_TOKEN = 'test-seeclickfix-token';
    process.env.PLATE_RECOGNIZER_API_KEY = 'test-plate-recognizer-key';
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-maps-key';
    global.fetch = vi.fn(async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => Buffer.from('{}'),
    }));
});

afterEach(() => {
    delete process.env.SEECLICKFIX_TOKEN;
    delete process.env.PLATE_RECOGNIZER_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    vi.unstubAllGlobals();
});

describe('missing/invalid url parameter', () => {
    it('400s when the url query parameter is missing', async () => {
        const req = makeReq({ url: undefined });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('400s when the url query parameter does not parse as a URL', async () => {
        const req = makeReq({ url: 'not a url' });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
    });
});

describe('host allowlist', () => {
    it('403s a host not in ALLOWED_HOSTS, before checking auth or calling upstream', async () => {
        const req = makeReq({ url: 'https://evil.example.com/steal' });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(verifyIdTokenMock).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('requireAuthorizedUser', () => {
    it('401s with no Authorization header', async () => {
        const req = makeReq({ url: 'https://seeclickfix.com/api/v2/issues' });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('401s a malformed Authorization header (not "Bearer <token>")', async () => {
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Basic abc123' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('401s when verifyIdToken rejects the token', async () => {
        verifyIdTokenMock.mockRejectedValue(new Error('bad signature'));
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer bad-token' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('403s a verified token for the wrong email', async () => {
        verifyIdTokenMock.mockResolvedValue({ email: 'someone-else@example.com', email_verified: true });
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token-wrong-user' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('403s the right email if Google has not verified it', async () => {
        verifyIdTokenMock.mockResolvedValue({ email: 'aschubatis@gmail.com', email_verified: false });
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer unverified-email' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('proceeds to call upstream for the right, verified email', async () => {
        verifyIdTokenMock.mockResolvedValue(VALID_TOKEN_USER);
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(200);
    });
});

describe('credential injection', () => {
    beforeEach(() => {
        verifyIdTokenMock.mockResolvedValue(VALID_TOKEN_USER);
    });

    it('mode "inject" attaches the env-var secret as an Authorization header with the configured scheme', async () => {
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(req, makeRes());
        const [, init] = global.fetch.mock.calls[0];
        expect(init.headers.authorization).toBe('Bearer test-seeclickfix-token');
    });

    it('mode "inject" (Token scheme) for Plate Recognizer', async () => {
        const req = makeReq({
            url: 'https://api.platerecognizer.com/v1/plate-reader/',
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(req, makeRes());
        const [, init] = global.fetch.mock.calls[0];
        expect(init.headers.authorization).toBe('Token test-plate-recognizer-key');
    });

    it('mode "query" appends the secret as a query parameter', async () => {
        const req = makeReq({
            url: 'https://maps.googleapis.com/maps/api/geocode/json?address=1+Main+St',
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(req, makeRes());
        const [calledUrl] = global.fetch.mock.calls[0];
        const parsed = new URL(calledUrl);
        expect(parsed.searchParams.get('key')).toBe('test-google-maps-key');
    });

    it('mode "query" overwrites (not appends to) a caller-supplied key param -- a caller cannot smuggle their own key value through', async () => {
        const req = makeReq({
            url: 'https://maps.googleapis.com/maps/api/geocode/json?key=caller-supplied-value',
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(req, makeRes());
        const [calledUrl] = global.fetch.mock.calls[0];
        const parsed = new URL(calledUrl);
        expect(parsed.searchParams.getAll('key')).toEqual(['test-google-maps-key']);
    });

    it('mode "forward" attaches the caller-supplied X-Upstream-Authorization, and nothing when absent', async () => {
        const reqWithCreds = makeReq({
            url: 'https://my.mailstream.app/send',
            headers: { authorization: 'Bearer good-token', 'x-upstream-authorization': 'Bearer mailstream-key' },
        });
        await handler(reqWithCreds, makeRes());
        expect(global.fetch.mock.calls[0][1].headers.authorization).toBe('Bearer mailstream-key');

        global.fetch.mockClear();
        const reqNoCreds = makeReq({
            url: 'https://my.mailstream.app/send',
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(reqNoCreds, makeRes());
        expect(global.fetch.mock.calls[0][1].headers.authorization).toBeUndefined();
    });

    it('mode "forward" never falls back to fabricating a credential from an env var', async () => {
        const req = makeReq({
            url: 'https://my.mailstream.app/send',
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(req, makeRes());
        const [, init] = global.fetch.mock.calls[0];
        expect(init.headers.authorization).toBeUndefined();
    });

    it('the anonymous-upstream header suppresses credential injection but still requires proxy auth', async () => {
        const authed = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token', 'x-upstream-anonymous': '1' },
        });
        await handler(authed, makeRes());
        expect(global.fetch.mock.calls[0][1].headers.authorization).toBeUndefined();

        global.fetch.mockClear();
        const unauthed = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { 'x-upstream-anonymous': '1' },
        });
        const res = makeRes();
        await handler(unauthed, res);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('500s (without calling upstream) when the required env var is missing', async () => {
        delete process.env.SEECLICKFIX_TOKEN;
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('header stripping', () => {
    beforeEach(() => {
        verifyIdTokenMock.mockResolvedValue(VALID_TOKEN_USER);
    });

    it('never forwards the caller-facing Authorization (proxy auth token) upstream unmodified', async () => {
        const req = makeReq({
            url: 'https://my.mailstream.app/send',
            // No x-upstream-authorization supplied -- if the proxy auth
            // token leaked through as the upstream credential, that would
            // be a serious bug (a caller's own ID token reaching a 3rd
            // party). It must never equal the proxy's own Bearer token.
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(req, makeRes());
        const [, init] = global.fetch.mock.calls[0];
        expect(init.headers.authorization).not.toBe('Bearer good-token');
    });

    it('only forwards the allowlisted request headers (content-type, accept, idempotency-key)', async () => {
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: {
                authorization: 'Bearer good-token',
                'content-type': 'application/json',
                accept: 'application/json',
                cookie: 'session=super-secret',
                host: 'improve-detroit.vercel.app',
            },
        });
        await handler(req, makeRes());
        const [, init] = global.fetch.mock.calls[0];
        expect(init.headers['content-type']).toBe('application/json');
        expect(init.headers.accept).toBe('application/json');
        expect(init.headers.cookie).toBeUndefined();
        expect(init.headers.host).toBeUndefined();
    });

    it('only forwards the allowlisted response header (content-type) back to the caller', async () => {
        global.fetch = vi.fn(async () => ({
            status: 200,
            headers: { get: (name) => (name === 'content-type' ? 'application/json' : 'ignore-me') },
            arrayBuffer: async () => Buffer.from('{}'),
        }));
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json');
        expect(res.setHeader).toHaveBeenCalledTimes(1);
    });
});

describe('request body forwarding', () => {
    beforeEach(() => {
        verifyIdTokenMock.mockResolvedValue(VALID_TOKEN_USER);
    });

    it('does not read/forward a body for GET requests', async () => {
        const req = makeReq({
            method: 'GET',
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token' },
        });
        await handler(req, makeRes());
        const [, init] = global.fetch.mock.calls[0];
        expect(init.body).toBeUndefined();
    });

    it('forwards the raw POST body byte-for-byte regardless of content type (e.g. multipart)', async () => {
        const req = makeReq({
            method: 'POST',
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token', 'content-type': 'multipart/form-data; boundary=X' },
            bodyChunks: ['--X\r\n', 'Content-Disposition: form-data\r\n\r\n', 'data--X--'],
        });
        await handler(req, makeRes());
        const [, init] = global.fetch.mock.calls[0];
        expect(init.body.toString()).toBe('--X\r\nContent-Disposition: form-data\r\n\r\ndata--X--');
    });
});

describe('upstream failure handling', () => {
    beforeEach(() => {
        verifyIdTokenMock.mockResolvedValue(VALID_TOKEN_USER);
    });

    it('502s when the upstream fetch itself rejects', async () => {
        global.fetch = vi.fn(async () => { throw new Error('network down'); });
        const req = makeReq({
            url: 'https://seeclickfix.com/api/v2/issues',
            headers: { authorization: 'Bearer good-token' },
        });
        const res = makeRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(502);
    });
});
