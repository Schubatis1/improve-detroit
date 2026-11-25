// Unit tests for api/mcp.js (the machine-facing API used by the pi-bridge MCP server): auth, read-only
// actions, and trigger_sync's dry-run-by-default behavior. firebase-admin and fetch are stubbed.
const admin = require('firebase-admin');

const DOCS = [
    { id: '101', data: { submittedAt: '2026-10-01T10:00:00Z', address: 'A St', status: 'Open', bluStatus: 'submitted', bikeBureauStatus: 'FAILED', photoUrl: 'https://secret/photo', lat: 1, lng: 2 } },
    { id: '102', data: { submittedAt: '2026-10-05T10:00:00Z', address: 'B St', status: 'Open', bluStatus: 'pending', bikeBureauStatus: 'pending' } },
    { id: '103', data: { submittedAt: '2026-10-09T10:00:00Z', address: 'C St', status: 'Closed', bluStatus: 'submitted', bikeBureauStatus: 'submitted' } },
];

// Records of everything the submit actions write, for assertions.
const WRITES = [];
const UPDATES = [];
const STORAGE_SAVES = [];

function fakeCollection(filters = [], name = 'history') {
    const rows = () => DOCS.filter((d) => filters.every(([f, v]) => d.data[f] === v));
    return {
        where: (f, op, v) => fakeCollection([...filters, [f, v]], name),
        limit: () => ({ get: async () => ({ docs: rows().map((d) => ({ id: d.id, data: () => d.data })) }) }),
        get: async () => ({ size: rows().length, docs: rows().map((d) => ({ id: d.id, data: () => d.data })) }),
        doc: (id) => ({
            _collection: name,
            _id: id,
            get: async () => { const d = DOCS.find((x) => x.id === id); return { exists: !!d, id, data: () => d && d.data }; },
            update: async (fields) => { UPDATES.push({ collection: name, id, fields }); },
        }),
    };
}

const authObj = { getUserByEmail: vi.fn(async () => ({ uid: 'uid1' })) };
const fsObj = {
    collection: () => ({ doc: () => ({ collection: (name) => fakeCollection([], name) }) }),
    batch: () => {
        const sets = [];
        return {
            set: (ref, data, opts) => sets.push({ ref, data, opts }),
            commit: async () => { for (const s of sets) WRITES.push({ collection: s.ref._collection, id: s.ref._id, data: s.data, opts: s.opts }); },
        };
    },
};
const defineAdmin = (k, v) => Object.defineProperty(admin, k, { value: v, configurable: true, writable: true });
defineAdmin('apps', []);
defineAdmin('initializeApp', vi.fn((opts, name) => { const app = { name }; admin.apps.push(app); return app; }));
defineAdmin('credential', { cert: vi.fn((x) => x) });
defineAdmin('auth', vi.fn(() => authObj));
defineAdmin('firestore', Object.assign(vi.fn(() => fsObj), { FieldValue: { arrayUnion: (v) => ({ __arrayUnion: [v] }) } }));
defineAdmin('storage', vi.fn(() => ({ bucket: () => ({ file: (path) => ({ save: async (buf) => { STORAGE_SAVES.push({ path, bytes: buf.length }); } }) }) })));

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
    WRITES.length = 0;
    UPDATES.length = 0;
    STORAGE_SAVES.length = 0;
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

describe('submit actions', () => {
    const REPORT = {
        photoBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
        lat: 42.3374,
        lng: -83.056,
        address: '2301 Cass Ave',
        summary: 'Vehicle Blocking Bike Lane',
        description: 'Cars queued into the garage.',
        plate: 'ABC 1234',
    };

    it('submit_report_suppressed is a dry run by default and touches nothing', async () => {
        const r = await call({ action: 'submit_report_suppressed', ...REPORT });
        expect(r.code).toBe(200);
        expect(r.body).toMatchObject({ dry_run: true, submitted: false });
        expect(r.body.plan.suppressed).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(WRITES).toEqual([]);
        expect(STORAGE_SAVES).toEqual([]);
    });

    it('submit_report_suppressed writes a Suppressed entry and never calls fetch (no SeeClickFix path)', async () => {
        const r = await call({ action: 'submit_report_suppressed', ...REPORT, dry_run: false });
        expect(r.code).toBe(200);
        expect(r.body.submitted).toBe(true);
        expect(r.body.issueId).toMatch(/^sup-\d+-[a-z0-9]+$/);
        expect(global.fetch).not.toHaveBeenCalled();
        const historyWrite = WRITES.find((w) => w.collection === 'history' && w.id === r.body.issueId);
        expect(historyWrite.data).toMatchObject({ suppressed: true, status: 'Suppressed', link: null, bluStatus: 'awaiting-photo', plate: 'ABC 1234' });
        expect(WRITES.some((w) => w.collection === 'plates')).toBe(true);
        expect(STORAGE_SAVES).toEqual([{ path: `history/uid1/${r.body.issueId}.jpg`, bytes: 15 }]);
        const upd = UPDATES.find((u) => u.collection === 'history' && u.id === r.body.issueId);
        expect(upd.fields).toMatchObject({ bluStatus: 'pending', bikeBureauStatus: 'pending' });
        expect(upd.fields.photoUrl).toContain(r.body.issueId);
        expect(r.body).toMatchObject({ bluStatus: 'pending', bikeBureauStatus: 'pending' });
    });

    it('submit actions validate before writing anything', async () => {
        expect((await call({ action: 'submit_report_suppressed', ...REPORT, photoBase64: '' })).code).toBe(400);
        expect((await call({ action: 'submit_report_suppressed', ...REPORT, bluCategory: 'Nope' })).code).toBe(400);
        expect((await call({ action: 'submit_report_suppressed', ...REPORT, category: 'other' })).code).toBe(400);
        expect(WRITES).toEqual([]);
    });

    it('submit_report_to_city is a dry run by default and files nothing', async () => {
        process.env.SEECLICKFIX_TOKEN = 'scf-secret';
        try {
            const r = await call({ action: 'submit_report_to_city', ...REPORT });
            expect(r.body).toMatchObject({ dry_run: true, submitted: false });
            expect(r.body.plan.suppressed).toBe(false);
            expect(global.fetch).not.toHaveBeenCalled();
            expect(WRITES).toEqual([]);
        } finally {
            delete process.env.SEECLICKFIX_TOKEN;
        }
    });

    it('get_report accepts suppressed ids (404, not 400) and still rejects junk', async () => {
        expect((await call({ action: 'get_report', issueId: 'sup-1234567890-abc123' })).code).toBe(404);
        expect((await call({ action: 'get_report', issueId: 'sup-x' })).code).toBe(400);
    });
});
