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
//   submit_report_suppressed  { ...report fields, dry_run?: true }  records a report + queues the BLU/BB
//                                                                   mirrors; NEVER contacts the City
//   submit_report_to_city     { ...report fields, dry_run?: true }  files a real SeeClickFix ticket,
//                                                                   then records it like the web app
//
// The two submit actions are separate names on purpose, with no shared "submit with a suppress flag":
// suppression in the web app is structural (the browser simply never calls SeeClickFix), and
// submit_report_suppressed mirrors that — its code path contains no SeeClickFix call at all. Both
// default dry_run to true; a real write/submission requires dry_run explicitly === false.
//
// Vercel env vars: MCP_API_TOKEN (shared secret), FIREBASE_SERVICE_ACCOUNT_JSON (write access to
// history + photo storage), GITHUB_ACTIONS_TOKEN (already set; used only by trigger_sync),
// SEECLICKFIX_TOKEN (already set for api/proxy.js; used only by submit_report_to_city).
const crypto = require('crypto');
const admin = require('firebase-admin');
const { parsePlateIds, parseCompanyIds, parseUsdotIds } = require('../lib/identity');

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
    if (!/^(\d{1,20}|sup-\d+-[a-z0-9]+)$/.test(String(body.issueId || ''))) throw failure(400, 'issueId must be a number or a suppressed-report id');
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

// --- Report submission ---
// The history-entry shape replicates addToHistory() in index.html field for field, including the
// awaiting-photo -> pending flip for bluStatus / bikeBureauStatus once the photo is actually in
// Storage (the scheduled submit-to-blu / submit-to-bikebureau scripts only pick up 'pending'
// entries that have photoUrl, lat and lng). Identity normalization reuses lib/identity.js so the
// plate/USDOT/company indexes can't drift from the app's.

const STORAGE_BUCKET = 'improve-detroit.firebasestorage.app'; // config.js: firebase.storageBucket
const SCF_API = 'https://seeclickfix.com/api/v2';
const VEHICLE_REQUEST_TYPE_ID = '22880'; // config.js: seeClickFix.requestTypeId
const NATURE_QUESTION_ID = '32751'; // config.js: seeClickFix.natureQuestionId
const TIMING_QUESTION_ID = '33446'; // config.js: seeClickFix.timingQuestionId
const BLU_CATEGORIES = [
    'Private Owner Vehicle',
    'Company Vehicle',
    'Construction',
    'Municipal (city) Vehicle - includes USPS',
    'Taxi / Uber / Livery / Lyft',
    'Other  (damaged lane / snow / debris / pedestrian / etc.)',
];

// adminApp() initializes without a storage bucket (it only reads Firestore). Photo upload needs
// one, so this variant sets it. A second named app keeps it from disturbing the read path.
function submitAdminApp() {
    const existing = admin.apps.find((a) => a && a.name === 'mcp-submit');
    if (existing) return existing;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw failure(500, 'Server is missing FIREBASE_SERVICE_ACCOUNT_JSON');
    let credential;
    try {
        credential = admin.credential.cert(JSON.parse(raw));
    } catch {
        throw failure(500, 'FIREBASE_SERVICE_ACCOUNT_JSON is not a valid service account');
    }
    return admin.initializeApp({ credential, storageBucket: STORAGE_BUCKET }, 'mcp-submit');
}

let cachedSubmitUid = null;
async function userRoot() {
    const app = submitAdminApp();
    if (!cachedSubmitUid) cachedSubmitUid = (await admin.auth(app).getUserByEmail(OWNER_EMAIL)).uid;
    return admin.firestore(app).collection('users').doc(cachedSubmitUid);
}

function requireString(body, field) {
    const v = body[field];
    if (typeof v !== 'string' || !v.trim()) throw failure(400, `${field} is required`);
    return v.trim();
}

function optionalString(body, field) {
    const v = body[field];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw failure(400, `${field} must be a string`);
    return v.trim() || null;
}

// Validates the shared report fields and decodes the photo. Throws failure(400)
// on anything off, before any write or network call happens.
function validateReport(body) {
    if (body.category !== undefined && body.category !== 'vehicle') {
        throw failure(400, "category must be 'vehicle' (the 'other'/pothole type is not supported yet)");
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw failure(400, 'lat and lng must be numbers');
    if (typeof body.photoBase64 !== 'string' || !body.photoBase64) throw failure(400, 'photoBase64 is required');
    const photo = Buffer.from(body.photoBase64, 'base64');
    if (!photo.length) throw failure(400, 'photoBase64 did not decode to any bytes');
    // Vercel's body limit is ~4.5MB; the web app downscales to ~1-2MB first.
    if (photo.length > 3.3 * 1024 * 1024) throw failure(400, 'photo is over ~3.3MB after base64 decode — downscale it first');
    const bluCategory = body.bluCategory === undefined ? BLU_CATEGORIES[0] : body.bluCategory;
    if (!BLU_CATEGORIES.includes(bluCategory)) throw failure(400, `bluCategory must be one of: ${BLU_CATEGORIES.join('; ')}`);
    return {
        lat,
        lng,
        address: requireString(body, 'address'),
        summary: requireString(body, 'summary'),
        description: requireString(body, 'description'),
        nature: optionalString(body, 'nature') || 'Car traveling in bike lane',
        timing: optionalString(body, 'timing'),
        vehicle: optionalString(body, 'vehicle'),
        plate: optionalString(body, 'plate'),
        companyName: optionalString(body, 'companyName'),
        usdotNumber: optionalString(body, 'usdotNumber'),
        photoTakenAt: optionalString(body, 'photoTakenAt'),
        bluCategory,
        photo,
    };
}

// The history entry, replicating addToHistory() in index.html. bluStatus /
// bikeBureauStatus start 'awaiting-photo' and are flipped by writeHistory()
// once the photo upload lands — same as the browser flow.
function buildEntry(r, { suppressed, issueId }) {
    const plateIds = parsePlateIds(r.plate || '');
    const usdotIds = parseUsdotIds(r.usdotNumber || '');
    const companyIds = usdotIds.length === 0 ? parseCompanyIds(r.companyName || '') : [];
    return {
        entry: {
            thumbnail: null, // browser generates a 96x96 canvas thumbnail; server-side needs `sharp` (v1 omits it)
            address: r.address,
            submittedAt: new Date().toISOString(),
            status: suppressed ? 'Suppressed' : 'Open',
            link: suppressed ? null : `https://seeclickfix.com/issues/${issueId}`,
            suppressed,
            geofenceId: null, // server-side geofence matching (lib/geo.js) is a possible follow-up
            lat: r.lat,
            lng: r.lng,
            metroCity: null,
            plate: r.plate,
            plateIds,
            companyName: r.companyName,
            companyIds,
            usdotNumber: r.usdotNumber,
            usdotIds,
            photoTakenAt: r.photoTakenAt,
            bluCategory: r.bluCategory,
            category: 'vehicle',
            description: r.description,
            bluStatus: 'awaiting-photo',
            bikeBureauStatus: 'awaiting-photo',
        },
        plateIds,
        usdotIds,
        companyIds,
    };
}

// Writes the history doc + plate/USDOT/company index docs in one batch, then
// uploads the photo and flips the mirror statuses — the same order the browser
// uses (durable record first, slow photo second).
async function writeHistory(r, { suppressed, issueId }) {
    const app = submitAdminApp();
    const root = await userRoot();
    const { entry, plateIds, usdotIds, companyIds } = buildEntry(r, { suppressed, issueId });
    const db = admin.firestore(app);
    const batch = db.batch();
    batch.set(root.collection('history').doc(String(issueId)), entry);
    for (const plateId of plateIds) {
        batch.set(root.collection('plates').doc(plateId), {
            plate: plateId,
            incidentIds: admin.firestore.FieldValue.arrayUnion(String(issueId)),
        }, { merge: true });
    }
    for (const usdotId of usdotIds) {
        const payload = { usdot: usdotId, incidentIds: admin.firestore.FieldValue.arrayUnion(String(issueId)) };
        if (r.companyName) payload.companyName = r.companyName;
        batch.set(root.collection('usdotNumbers').doc(usdotId), payload, { merge: true });
    }
    for (const companyId of companyIds) {
        batch.set(root.collection('companies').doc(companyId), {
            company: companyId,
            incidentIds: admin.firestore.FieldValue.arrayUnion(String(issueId)),
        }, { merge: true });
    }
    await batch.commit();

    let photoFields;
    try {
        const path = `history/${cachedSubmitUid}/${issueId}.jpg`;
        const file = admin.storage(app).bucket().file(path);
        const token = crypto.randomUUID();
        await file.save(r.photo, {
            contentType: 'image/jpeg',
            metadata: { metadata: { firebaseStorageDownloadTokens: token } },
        });
        const photoUrl = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
        photoFields = { photoUrl, bluStatus: 'pending', bikeBureauStatus: 'pending' };
    } catch {
        photoFields = { bluStatus: 'photo-upload-failed', bikeBureauStatus: 'photo-upload-failed' };
    }
    await root.collection('history').doc(String(issueId)).update(photoFields);
    return { ...entry, ...photoFields };
}

function describePlan(r, suppressed) {
    const { photo, ...fields } = r;
    return { ...fields, photoBytes: photo.length, suppressed };
}

// SUPPRESSED: records the report and queues it for Bike Lane Uprising / Bike
// Bureau, and — by construction — never contacts SeeClickFix or the City.
async function submitReportSuppressed(body) {
    const r = validateReport(body);
    if (body.dry_run !== false) {
        return { dry_run: true, submitted: false, plan: describePlan(r, true), note: 'dry run: nothing written; pass dry_run=false to log this report (it still never goes to the City)' };
    }
    const syntheticId = `sup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const entry = await writeHistory(r, { suppressed: true, issueId: syntheticId });
    return { dry_run: false, submitted: true, issueId: syntheticId, suppressed: true, bluStatus: entry.bluStatus, bikeBureauStatus: entry.bikeBureauStatus };
}

// CITY: files a real SeeClickFix ticket, then records it exactly like the web
// app does. Only reachable by calling this action by name.
async function submitReportToCity(body) {
    const token = process.env.SEECLICKFIX_TOKEN;
    if (!token) throw failure(500, 'Server is missing SEECLICKFIX_TOKEN');
    const r = validateReport(body);
    if (body.dry_run !== false) {
        return { dry_run: true, submitted: false, plan: describePlan(r, false), note: 'dry run: no ticket filed; pass dry_run=false to file a real City of Detroit ticket' };
    }

    const auth = { authorization: `Bearer ${token}` };
    // The vehicle/plate answer goes under a question id that has to be read
    // off the live request-type schema (same lookup as index.html's
    // getVehicleInfoQuestionId: the question whose text mentions "make, model").
    const schemaRes = await fetch(`${SCF_API}/request_types/${VEHICLE_REQUEST_TYPE_ID}`, { headers: auth });
    if (!schemaRes.ok) throw failure(502, `SeeClickFix schema fetch failed (${schemaRes.status})`);
    const schema = await schemaRes.json();
    const vehicleQ = (schema.questions || []).find((q) => typeof q.question === 'string' && q.question.toLowerCase().includes('make, model'));
    const vehicleQuestionId = vehicleQ ? String(vehicleQ.id ?? vehicleQ.primary_key ?? '') : '';

    const vehicleAndPlate = [
        [r.vehicle, r.plate].filter(Boolean).join(' '),
        r.companyName,
        r.usdotNumber ? `USDOT #${r.usdotNumber}` : '',
    ].filter(Boolean).join(', ');

    const form = new FormData();
    form.append('lat', String(r.lat));
    form.append('lng', String(r.lng));
    form.append('address', r.address);
    form.append('request_type_id', VEHICLE_REQUEST_TYPE_ID);
    form.append('answers[summary]', r.summary);
    form.append('answers[description]', r.description);
    form.append(`answers[${NATURE_QUESTION_ID}]`, r.nature);
    if (r.timing) form.append(`answers[${TIMING_QUESTION_ID}]`, r.timing);
    if (vehicleQuestionId && vehicleAndPlate) form.append(`answers[${vehicleQuestionId}]`, vehicleAndPlate);
    form.append('answers[issue_image]', new Blob([r.photo], { type: 'image/jpeg' }), 'photo.jpg');

    // Same retry policy as the browser: transient statuses only, and only
    // before a ticket is confirmed created, so a retry can't duplicate one.
    let data;
    for (let attempt = 1; ; attempt++) {
        let res;
        try {
            res = await fetch(`${SCF_API}/issues`, { method: 'POST', headers: auth, body: form });
        } catch (netErr) {
            if (attempt >= 3) throw failure(502, `SeeClickFix unreachable: ${netErr.message}`);
            continue;
        }
        if (res.ok) {
            data = await res.json();
            break;
        }
        const transient = [405, 429, 502, 503, 504].includes(res.status);
        if (!transient || attempt >= 3) throw failure(502, `SeeClickFix refused the submission (${res.status}): ${await res.text()}`);
    }

    const entry = await writeHistory(r, { suppressed: false, issueId: data.id });
    return { dry_run: false, submitted: true, issueId: String(data.id), link: entry.link, bluStatus: entry.bluStatus, bikeBureauStatus: entry.bikeBureauStatus };
}

const ACTIONS = { list_reports: listReports, get_report: getReport, sync_status: syncStatus, trigger_sync: triggerSync, submit_report_suppressed: submitReportSuppressed, submit_report_to_city: submitReportToCity };

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
