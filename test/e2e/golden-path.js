#!/usr/bin/env node
/**
 * Playwright smoke test for the app's golden path: load -> signed-in state
 * -> tab switching -> selecting a photo mounts a queue card. Follows this
 * repo's own precedent (see the PR descriptions for v3.14.0-v3.16.1):
 * since this sandbox's network policy blocks the CDN hosts the app depends
 * on (Firebase, Leaflet, exifr, Tailwind), those are stubbed with minimal
 * fakes via page.route() + an init script, and the REAL, unmodified
 * index.html/lib/*.js run against them -- this is not a mock of the app's
 * own logic, only of the third-party SDKs it loads.
 *
 * Deliberately scoped to a smoke test, not a full submission round-trip:
 * asserts that selecting a file reaches addQueueItem/mountItemCard (this
 * exact path broke in production once -- see the v3.15.1 fix, "selecting
 * a photo did nothing for any returning user") and that the page loads
 * and the primary tabs render with no console/page errors. It does NOT
 * exercise processQueueItem's async classification chain (Gemini/Plate
 * Recognizer/geocoding) -- that would need a much larger stub surface for
 * comparatively little regression-catching value over the unit tests
 * already covering that logic's pure pieces (lib/*.js, test/*.test.js).
 *
 * Usage: node test/e2e/golden-path.js
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..', '..');
// This sandbox pre-installs Chromium at a fixed path (see CLAUDE.md/the
// environment notes) rather than the usual `npx playwright install`
// location -- use it when present, but fall back to Playwright's normal
// browser resolution (e.g. in CI, where `playwright install` puts it
// wherever Playwright itself expects) rather than hardcoding a path that
// wouldn't exist there.
const SANDBOX_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH
    || (fs.existsSync(SANDBOX_CHROMIUM_PATH) ? SANDBOX_CHROMIUM_PATH : undefined);

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };

// Served over real http:// rather than file:// -- fetch('/api/proxy?...')
// (a root-relative path) hits the browser's CORS policy under a file:
// origin (blocked even with page.route() interception, since that check
// happens before routing), but works fine same-origin over http.
function startStaticServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const reqPath = req.url.split('?')[0];
            const filePath = path.join(REPO_ROOT, reqPath === '/' ? 'index.html' : reqPath);
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                const ext = path.extname(filePath);
                res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const FAKE_USER = {
    uid: 'test-uid',
    email: 'aschubatis@gmail.com',
    emailVerified: true,
};

// Injected before any page script runs, so by the time the (stubbed, see
// below) CDN scripts and the app's own inline script execute, window.L/
// window.exifr/window.firebase are already the fakes.
const INIT_SCRIPT = `
(function () {
    function chainable() {
        const obj = {};
        const methods = ['setView', 'addTo', 'on', 'off', 'remove', 'setLatLng', 'bindPopup',
            'openPopup', 'setStyle', 'setRadius', 'addLayer', 'removeLayer', 'invalidateSize', 'redraw'];
        methods.forEach((m) => { obj[m] = () => obj; });
        obj.getLatLng = () => ({ lat: 42.3314, lng: -83.0458 });
        return obj;
    }
    window.tailwind = { config: {} };

    window.L = {
        map: () => chainable(),
        tileLayer: () => chainable(),
        marker: () => chainable(),
        circleMarker: () => chainable(),
        circle: () => chainable(),
        polygon: () => chainable(),
        icon: () => ({}),
        divIcon: () => ({}),
        featureGroup: () => chainable(),
    };

    window.exifr = {
        parse: async () => ({ DateTimeOriginal: new Date().toISOString() }),
        gps: async () => ({ latitude: 42.3314, longitude: -83.0458 }),
    };

    const emptySnapshot = { docs: [], empty: true, size: 0, forEach: () => {} };
    function docStub() {
        return {
            id: 'stub-doc',
            collection: () => collectionStub(),
            get: async () => ({ exists: false, data: () => undefined, id: 'stub-doc' }),
            set: async () => {},
            update: async () => {},
            delete: async () => {},
            onSnapshot: (cb) => { cb(emptySnapshot); return () => {}; },
        };
    }
    function collectionStub() {
        return {
            doc: (id) => docStub(id),
            add: async () => docStub(),
            get: async () => emptySnapshot,
            where: () => collectionStub(),
            limit: () => collectionStub(),
            orderBy: () => collectionStub(),
            onSnapshot: (cb) => { cb(emptySnapshot); return () => {}; },
        };
    }
    const firestoreStub = {
        collection: () => collectionStub(),
        batch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} }),
    };
    firestoreStub.FieldValue = {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
        arrayUnion: (...a) => ({ __op: 'arrayUnion', a }),
        delete: () => ({ __op: 'delete' }),
        increment: (n) => ({ __op: 'increment', n }),
    };

    let authCallback = null;
    const FAKE_USER = ${JSON.stringify(FAKE_USER)};
    const fakeUserWithToken = Object.assign({}, FAKE_USER, { getIdToken: async () => 'fake-id-token' });
    const authStub = {
        onAuthStateChanged: (cb) => { authCallback = cb; cb(fakeUserWithToken); return () => {}; },
        signInWithPopup: async () => ({ user: fakeUserWithToken }),
        signOut: async () => { if (authCallback) authCallback(null); },
        get currentUser() { return fakeUserWithToken; },
    };
    authStub.GoogleAuthProvider = function GoogleAuthProvider() {};

    const storageStub = {
        ref: () => ({
            put: async () => ({ ref: { getDownloadURL: async () => 'https://example.com/fake.jpg' } }),
        }),
    };

    window.firebase = {
        initializeApp: () => {},
        auth: () => authStub,
        firestore: () => firestoreStub,
        storage: () => storageStub,
    };
    window.firebase.auth.GoogleAuthProvider = authStub.GoogleAuthProvider;
    window.firebase.firestore.FieldValue = firestoreStub.FieldValue;
})();
`;

async function main() {
    const failures = [];
    function check(condition, message) {
        if (condition) {
            console.log(`  ok - ${message}`);
        } else {
            console.error(`  FAIL - ${message}`);
            failures.push(message);
        }
    }

    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
    const page = await browser.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
        consoleErrors.push(`pageerror: ${err.message}`);
    });

    // Every third-party CDN script the page loads (see index.html's <head>)
    // -- fulfilled with an empty, valid script so the browser doesn't hang
    // on a host this sandbox can't reach. window.L/exifr/firebase are
    // already set by the init script above by the time these "load".
    const STUBBED_HOSTS = [
        'cdn.tailwindcss.com',
        'www.gstatic.com',
        'cdn.jsdelivr.net',
    ];
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (STUBBED_HOSTS.some((host) => url.hostname === host)) {
            return route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed for test\n' });
        }
        // Any other external call this sandbox can't reach (e.g. a stray
        // /api/proxy fetch during async classification, which this smoke
        // test doesn't exercise) -- fail it fast rather than hanging.
        if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
            return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"stubbed-network-unavailable"}' });
        }
        return route.continue();
    });

    await page.addInitScript(INIT_SCRIPT);

    const server = await startStaticServer();
    const port = server.address().port;
    console.log(`Loading http://127.0.0.1:${port}/index.html ...`);
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 30000 });

    // Let onAuthStateChanged's fake-signed-in callback and its async
    // continuation (initHistorySync/initGeofencesSync/etc., all against
    // the Firestore stub above) settle.
    await page.waitForTimeout(500);

    check(
        await page.locator('#appContent').isVisible().catch(() => false),
        'app content is visible after the fake sign-in'
    );

    // Tab switching (Reports / Repeat Offenders / Stats).
    await page.locator('#offendersTabBtn').click();
    check(
        await page.locator('#offendersTab').isVisible().catch(() => false),
        'clicking the Repeat Offenders tab shows #offendersTab'
    );
    await page.locator('#statsTabBtn').click();
    check(
        await page.locator('#statsTab').isVisible().catch(() => false),
        'clicking the Stats tab shows #statsTab'
    );
    await page.locator('#reportsTabBtn').click();
    check(
        await page.locator('#reportsTab').isVisible().catch(() => false),
        'clicking back to the Reports tab shows #reportsTab'
    );

    // The golden path this test exists for: selecting a photo must reach
    // addQueueItem/mountItemCard and put a card on screen. This exact path
    // broke in production once (v3.15.1: a ReferenceError earlier in the
    // script silently prevented this change listener from ever being
    // registered) -- this is the regression class this test guards.
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await page.setInputFiles('#photoInput', {
        name: 'test-photo.png',
        mimeType: 'image/png',
        buffer: Buffer.from(tinyPngBase64, 'base64'),
    });

    await page.waitForTimeout(500);

    const queueCards = page.locator('#queueContainer > div');
    check((await queueCards.count()) >= 1, 'selecting a photo mounts a card in #queueContainer');

    const unexpectedErrors = consoleErrors.filter((e) =>
        // Expected: the geocode/classification chain hits our 502 stub for
        // any host this test doesn't otherwise fake -- that's the point of
        // scoping this to a smoke test (see the file header comment), not
        // a bug to fail on.
        !/stubbed-network-unavailable|Google Maps API HTTP Error|Failed to load resource/i.test(e)
    );
    check(unexpectedErrors.length === 0, `no unexpected console/page errors (saw: ${JSON.stringify(unexpectedErrors)})`);

    await browser.close();
    server.close();

    if (failures.length > 0) {
        console.error(`\n${failures.length} check(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll checks passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
