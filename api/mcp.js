// Machine-facing API for the pi-bridge MCP server (Adam's Raspberry Pi), so an assistant can look at
// bike-lane reports and the Bike Lane Uprising / Bike Bureau mirror status WITHOUT driving the web UI and
// WITHOUT touching Firestore directly.
//
// Separate from api/proxy.js on purpose: the proxy is a credential-injecting relay that only accepts a
// Firebase ID token for the signed-in browser user. This function is a narrow, server-side API for one
// non-browser caller, authenticated by a single shared secret (MCP_API_TOKEN) that never reaches a browser.
//
// POST /api/mcp   Authorization: Bearer <MCP_API_TOKEN>   body: { "action": "...", ...params }
//
//   list_reports   { status?, bluStatus?, bikeBureauStatus?, since?, limit? (1-100, default 25) }  read-only
//   get_report     { issueId }                                                                     read-only
//   sync_status    {}                                                                              read-only
//   trigger_sync   { target: 'blu'|'bikebureau', dry_run?: true }                                  dry_run by default
//
// There is deliberately NO action that files a new report with the City: that spends a real SeeClickFix
// ticket and needs the photo pipeline, so it stays a human-in-the-app step.
//
// Vercel env vars: MCP_API_TOKEN (shared secret), FIREBASE_SERVICE_ACCOUNT_JSON (read access to history),
// GITHUB_ACTIONS_TOKEN (already set; used only by trigger_sync).
const crypto = require('crypto');
const admin = require('firebase-admin');

const OWNER_EMAIL = 'aschubatis@gmail.com';
const REPO = 'Schubatis1/improve-detroit';
const WORKFLOWS = { blu: 'submit-to-blu.yml', bikebureau: 'submit-to-bikebureau.yml' };
const MAX_LIMIT = 100;

let cachedUid = null;

function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

function authorized(req) {
    const expected = process.env.MCP_API_TOKEN;
    if (!expected) return false;
    const match = /^Bearer (.+)$/i.exec((req.headers.authorization || '').trim());
    if (!match) return false;
    return crypto.timingSafeEqual(digest(match[1]), digest(expected));
}

function failure(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// A named app, so this never collides with api/proxy.js's credential-less default app.
function adminApp() {
    const existing = admin.apps.find((a) => a && a.name === 'mcp');
    if (existing) return existing;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw failure(500, 'Server is missing FIREBASE_SERVICE_ACCOUNT_JSON');
    let credential;
    try {
        credential = admin.credential.cert(JSON.parse(raw));
    } catch {
        throw failure(500, 'FIREBASE_SERVICE_ACCOUNT_JSON is not a valid service account');
    }
    return admin.initializeApp({ credential }, 'mcp');
}

async function historyCollection() {
    const app = adminApp();
    if (!cachedUid) cachedUid = (await admin.auth(app).getUserByEmail(OWNER_EMAIL)).uid;
    return admin.firestore(app).collection('users').doc(cachedUid).collection('history');
}

// Everything a caller needs to talk about a report; never the photo URL or raw coordinates beyond the address.
function summarize(id, e) {
    return {
        issueId: String(id),
        submittedAt: e.submittedAt || null,
        photoTakenAt: e.photoTakenAt || null,
        address: e.address || null,
        category: e.category || null,
        plate: e.plate || null,
        companyName: e.companyName || null,
        status: e.status || null,
        bluStatus: e.bluStatus || null,
        bikeBureauStatus: e.bikeBureauStatus || null,
        parkingDeptFlag: e.parkingDeptFlag || null,
        description: e.description || null,
        link: e.link || null,
    };
}

async function listReports(body) {
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 25, 1), MAX_LIMIT);
    let q = await historyCollection();
    for (const field of ['status', 'bluStatus', 'bikeBureauStatus']) {
        if (body[field] !== undefined) {
            if (typeof body[field] !== 'string') throw failure(400, `${field} must be a string`);
            q = q.where(field, '==', body[field]);
        }
    }
    const snap = await q.limit(500).get();
    let rows = snap.docs.map((d) => summarize(d.id, d.data()));
    if (body.since) {
        const since = Date.parse(body.since);
        if (Number.isNaN(since)) throw failure(400, 'since must be an ISO date');
        rows = rows.filter((r) => r.submittedAt && Date.parse(r.submittedAt) >= since);
    }
    rows.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
    return { count: Math.min(rows.length, limit), reports: rows.slice(0, limit) };
}

async function getReport(body) {
    if (!/^\d{1,20}$/.test(String(body.issueId || ''))) throw failure(400, 'issueId must be a number');
    const doc = await (await historyCollection()).doc(String(body.issueId)).get();
    if (!doc.exists) throw failure(404, 'No report with that issueId');
    return { report: summarize(doc.id, doc.data()) };
}

async function syncStatus() {
    const snap = await (await historyCollection()).get();
    const tally = { blu: {}, bikeBureau: {} };
    snap.docs.forEach((d) => {
        const e = d.data();
        const b = e.bluStatus || 'none';
        const k = e.bikeBureauStatus || 'none';
        tally.blu[b] = (tally.blu[b] || 0) + 1;
        tally.bikeBureau[k] = (tally.bikeBureau[k] || 0) + 1;
    });
    return { totalReports: snap.size, blu: tally.blu, bikeBureau: tally.bikeBureau };
}

async function triggerSync(body) {
    const workflow = WORKFLOWS[body.target];
    if (!workflow) throw failure(400, "target must be 'blu' or 'bikebureau'");
    const dryRun = body.dry_run !== false; // only an explicit false sends anything
    if (!dryRun && !process.env.GITHUB_ACTIONS_TOKEN) throw failure(500, 'Server is missing GITHUB_ACTIONS_TOKEN');
    const plan = { target: body.target, workflow, mirrorsPendingReports: !dryRun };
    if (dryRun) {
        return { dry_run: true, dispatched: false, plan, note: 'dry run: nothing dispatched; pass dry_run=false to mirror pending reports now' };
    }
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${process.env.GITHUB_ACTIONS_TOKEN}`,
            'user-agent': 'improve-detroit-mcp',
            'x-github-api-version': '2022-11-28',
            'content-type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { dry_run: 'false' } }),
    });
    if (res.status !== 204) throw failure(502, `GitHub refused the dispatch (${res.status})`);
    return { dry_run: false, dispatched: true, plan };
}

const ACTIONS = { list_reports: listReports, get_report: getReport, sync_status: syncStatus, trigger_sync: triggerSync };

async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'POST only' });
        return;
    }
    if (!authorized(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const run = Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!run) {
        res.status(400).json({ error: `Unknown action: ${body.action}` });
        return;
    }
    try {
        res.status(200).json(await run(body));
    } catch (err) {
        // Messages built via failure() are safe to return; anything else is reported generically.
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' });
    }
}

module.exports = handler;
