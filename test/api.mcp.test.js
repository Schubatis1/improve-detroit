// Unit tests for api/mcp.js (the machine-facing API used by the pi-bridge MCP server): auth, read-only
// actions, and trigger_sync's dry-run-by-default behavior. firebase-admin and fetch are stubbed.
const admin = require('firebase-admin');

const DOCS = [
    { id: '101', data: { submittedAt: '2026-10-01T10:00:00Z', address: 'A St', status: 'Open', bluStatus: 'submitted', bikeBureauStatus: 'FAILED', photoUrl: 'https://secret/photo', lat: 1, lng: 2 } },
    { id: '102', data: { submittedAt: '2026-10-05T10:00:00Z', address: 'B St', status: 'Open', bluStatus: 'pending', bikeBureauStatus: 'pending' } },
    { id: '103', data: { submittedAt: '2026-10-09T10:00:00Z', address: 'C St', status: 'Closed', bluStatus: 'submitted', bikeBureauStatus: 'submitted' } },
];

function fakeCollection(filters = []) {
    const rows = () => DOCS.filter((d) => filters.every(([f, v]) => d.data[f] === v));
    return {
        where: (f, op, v) => fakeCollection([...filters, [f, v]]),
        limit: () => ({ get: async () => ({ docs: rows().map((d) => ({ id: d.id, data: () => d.data })) }) }),
        get: async () => ({ size: rows().length, docs: rows().map((d) => ({ id: d.id, data: () => d.data })) }),
        doc: (id) => ({ get: async () => { const d = DOCS.find((x) => x.id === id); return { exists: !!d, id, data: () => d && d.data }; } }),
    };
}

const authObj = { getUserByEmail: vi.fn(async () => ({ uid: 'uid1' })) };
const fsObj = { collection: () => ({ doc: () => ({ collection: () => fakeCollection() }) }) };
const defineAdmin = (k, v) => Object.defineProperty(admin, k, { value: v, configurable: true, writable: true });
defineAdmin('apps', []);
defineAdmin('initializeApp', vi.fn((opts, name) => { const app = { name }; admin.apps.push(app); return app; }));
defineAdmin('credential', { cert: vi.fn((x) => x) });
defineAdmin('auth', vi.fn(() => authObj));
defineAdmin('firestore', vi.fn(() => fsObj));

const handler = require('../api/mcp.js');

function call(body, { token = 'tok', method = 'POST' } = {}) {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const req = { method, headers: token === null ? {} : { authorization: `Bearer ${token}` }, body };
    return handler(req, res).then(() => res);
}

beforeEach(() => {
    process.env.MCP_API_TOKEN = 'tok';
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'p' });
    process.env.GITHUB_ACTIONS_TOKEN = 'gh-secret';
    global.fetch = vi.fn(async () => ({ status: 204 }));
});

describe('auth', () => {
    it('rejects missing, wrong and unconfigured tokens', async () => {
        expect((await call({ action: 'sync_status' }, { token: null })).code).toBe(401);
        expect((await call({ action: 'sync_status' }, { token: 'nope' })).code).toBe(401);
        delete process.env.MCP_API_TOKEN;
        expect((await call({ action: 'sync_status' }, { token: 'undefined' })).code).toBe(401);
    });
    it('rejects non-POST and unknown actions', async () => {
        expect((await call({}, { method: 'GET' })).code).toBe(405);
        expect((await call({ action: 'delete_everything' })).code).toBe(400);
        expect((await call({ action: 'constructor' })).code).toBe(400);
    });
});

describe('read actions', () => {
    it('list_reports filters, sorts newest first and omits photos/coordinates', async () => {
        const r = await call({ action: 'list_reports', bikeBureauStatus: 'FAILED' });
        expect(r.code).toBe(200);
        expect(r.body.reports.map((x) => x.issueId)).toEqual(['101']);
        expect(JSON.stringify(r.body)).not.toMatch(/secret\/photo|"lat"/);
        const all = await call({ action: 'list_reports', limit: 2 });
        expect(all.body.reports.map((x) => x.issueId)).toEqual(['103', '102']);
        const since = await call({ action: 'list_reports', since: '2026-10-05' });
        expect(since.body.reports.map((x) => x.issueId)).toEqual(['103', '102']);
        expect((await call({ action: 'list_reports', since: 'junk' })).code).toBe(400);
    });
    it('get_report validates ids and 404s', async () => {
        expect((await call({ action: 'get_report', issueId: '101' })).body.report.address).toBe('A St');
        expect((await call({ action: 'get_report', issueId: '999' })).code).toBe(404);
        expect((await call({ action: 'get_report', issueId: '../x' })).code).toBe(400);
    });
    it('sync_status tallies both mirrors', async () => {
        const r = (await call({ action: 'sync_status' })).body;
        expect(r.totalReports).toBe(3);
        expect(r.bikeBureau).toEqual({ FAILED: 1, pending: 1, submitted: 1 });
        expect(r.blu).toEqual({ submitted: 2, pending: 1 });
    });
});

describe('trigger_sync', () => {
    it('is a dry run by default and sends nothing', async () => {
        const r = await call({ action: 'trigger_sync', target: 'blu' });
        expect(r.body).toMatchObject({ dry_run: true, dispatched: false });
        expect(global.fetch).not.toHaveBeenCalled();
    });
    it('dispatches only with an explicit dry_run=false, and never leaks the GitHub token', async () => {
        const r = await call({ action: 'trigger_sync', target: 'bikebureau', dry_run: false });
        expect(r.body).toMatchObject({ dry_run: false, dispatched: true });
        expect(global.fetch.mock.calls[0][0]).toContain('submit-to-bikebureau.yml/dispatches');
        expect(JSON.stringify(r.body)).not.toContain('gh-secret');
    });
    it('rejects unknown targets and reports GitHub refusals', async () => {
        expect((await call({ action: 'trigger_sync', target: 'x' })).code).toBe(400);
        global.fetch = vi.fn(async () => ({ status: 403 }));
        expect((await call({ action: 'trigger_sync', target: 'blu', dry_run: false })).code).toBe(502);
    });
});
