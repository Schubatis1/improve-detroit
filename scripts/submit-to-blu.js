#!/usr/bin/env node
/**
 * Mirrors pending "You Can't Park There" submissions to Bike Lane Uprising
 * (bikelaneuprising.com), which has no public API -- this drives the real
 * submit form with Playwright instead of replicating BLU's internal
 * Wix/Cognito auth exchange. Meant to run on a schedule (see
 * .github/workflows/submit-to-blu.yml); safe to re-run since it only acts
 * on Firestore history entries with bluStatus == "pending" and always
 * updates that field afterward.
 *
 * Env vars:
 *   BLU_EMAIL, BLU_PASSWORD       -- your bikelaneuprising.com login
 *   FIREBASE_SERVICE_ACCOUNT_JSON -- the service account key, as a JSON string
 *     (or pass --service-account <path> to read it from a file instead)
 *
 * Usage:
 *   node scripts/submit-to-blu.js [--email you@example.com] [--limit 10]
 *     [--dry-run] [--headed] [--service-account Secrets/serviceAccountKey.json]
 *
 *   --dry-run fills out each form and screenshots it into scripts/dry-run/
 *     without clicking the final Submit button, and leaves bluStatus alone.
 *     Run this (with --headed to actually watch it) before trusting the
 *     scheduled workflow -- BLU's date/time fields are custom widgets this
 *     script fills by typing into them, which is the part most likely to
 *     need adjusting for your account/locale.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const admin = require('firebase-admin');
const { chromium } = require('playwright');

const SUBMIT_URL = 'https://www.bikelaneuprising.com/submit';

// BLU's <select> option labels, copied verbatim from the live form -- must
// match exactly (case, spacing) since Playwright selects by visible label.
const PLATE_STATE_MICHIGAN = 'MICHIGAN (MI)';
const PLATE_STATE_NONE = 'NO PLATE ON VEHICLE';
const METRO_CITY_DETROIT = 'Detroit - MI';

function parseArgs(argv) {
    const args = { email: 'aschubatis@gmail.com', limit: 10 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--headed') args.headed = true;
        else if (a === '--email') args.email = argv[++i];
        else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
        else if (a === '--service-account') args.serviceAccount = argv[++i];
    }
    return args;
}

function loadServiceAccount(args) {
    if (args.serviceAccount) {
        return JSON.parse(fs.readFileSync(path.resolve(args.serviceAccount), 'utf8'));
    }
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }
    throw new Error('Provide credentials via --service-account <path> or FIREBASE_SERVICE_ACCOUNT_JSON.');
}

async function downloadToTempFile(url, destPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Photo download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

async function debugDump(page, label) {
    const dir = path.join(__dirname, 'dry-run');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `debug-${label}.png`), fullPage: true }).catch(() => {});
    const buttons = await page.locator('button, [role="button"], a').evaluateAll((els) =>
        els.slice(0, 60).map((el) => (el.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
    ).catch(() => []);
    fs.writeFileSync(path.join(dir, `debug-${label}-buttons.json`), JSON.stringify(buttons, null, 2));

    // Calendar/datepicker-flavored elements specifically, with enough of
    // their DOM (tag, role, class, a few data-* attrs, short text) to write
    // real selectors from -- generic button/link text alone won't show a
    // calendar grid's day cells.
    const calendarInfo = await page.evaluate(() => {
        const matches = Array.from(document.querySelectorAll(
            '[class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i], [role="grid"], [role="gridcell"], [role="dialog"], [class*="popover" i]'
        ));
        return matches.slice(0, 30).map((el) => ({
            tag: el.tagName,
            class: el.className && el.className.toString().slice(0, 120),
            role: el.getAttribute('role'),
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
            childCount: el.children.length,
        }));
    }).catch((err) => [{ error: String(err) }]);
    fs.writeFileSync(path.join(dir, `debug-${label}-calendar.json`), JSON.stringify(calendarInfo, null, 2));
}

async function dismissOverlays(page) {
    // Two overlays can sit on top of the real page content on a fresh
    // session: a Usercentrics cookie-consent banner, and a "Love Our
    // Work?" donation banner across the top (both confirmed via a debug
    // screenshot during setup). Dismiss whichever appear; neither is
    // always present, so failures to find them are expected, not errors.
    const dismissers = [
        page.getByRole('button', { name: /accept all|accept|got it/i }).first(),
        page.getByRole('button', { name: /^close$/i }).first(),
        page.locator('[aria-label="Close" i], [data-hook*="close" i], [title="Close" i]').first(),
    ];
    for (const button of dismissers) {
        try {
            await button.waitFor({ state: 'visible', timeout: 3000 });
            await button.click();
        } catch {
            // Not shown -- nothing to dismiss.
        }
    }
}

async function loginToBlu(page, email, password) {
    // Wix pages never go network-idle (constant frog.wix.com/telemetry
    // background traffic), so 'networkidle' reliably times out here --
    // wait for the DOM plus a real element instead.
    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: 30000 });
    await dismissOverlays(page);

    const alreadyLoggedIn = await page.getByRole('button', { name: /log out/i }).count();
    if (alreadyLoggedIn > 0) return;

    // The /submit page shows an inline Email/Password login form directly
    // when signed out (not a nav-bar "Login/Sign up" button + modal, which
    // is what the header elsewhere on the site uses) -- confirmed via a
    // debug screenshot during setup.
    try {
        await page.locator('input[type="email"]').first().waitFor({ state: 'visible', timeout: 15000 });
    } catch (err) {
        await debugDump(page, 'login-form-not-found');
        throw err;
    }
    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);

    // The Log in click is flaky in ways that don't show up in a debug
    // screenshot: sometimes it logs in within a few seconds (confirmed via
    // a captured login.jsw 200 response), sometimes an identical-looking
    // click never fires the request at all. force: true skips Playwright's
    // "stable" wait (a plain click reliably times out on that check, cause
    // unconfirmed -- possibly a hover/scroll-reveal transition that never
    // settles), but doesn't fix the click sometimes just not registering.
    // Retrying the click itself (not just waiting longer) works around it.
    let loggedIn = false;
    for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
        await page.getByRole('button', { name: /^log in$/i }).first().click({ force: true });
        try {
            await page.getByRole('button', { name: /log out/i }).first().waitFor({ state: 'visible', timeout: 15000 });
            loggedIn = true;
        } catch {
            console.log(`  Log in attempt ${attempt} didn't complete in 15s, retrying...`);
        }
    }
    if (!loggedIn) {
        await debugDump(page, 'log-in-click-failed');
        throw new Error('Could not log into BLU after 3 attempts');
    }
}

async function fillSubmitForm(page, entry, photoPath, notes) {
    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: 30000 });
    await dismissOverlays(page);

    // The visible photo input is the first file input on the page.
    await page.locator('input[type="file"]').first().setInputFiles(photoPath);

    const category = entry.bluCategory || 'Private Owner Vehicle';
    await page.locator('select').nth(0).selectOption({ label: category });

    const hasPlate = !!(entry.plate && entry.plate.trim());
    await page.locator('select').nth(1).selectOption({ label: hasPlate ? PLATE_STATE_MICHIGAN : PLATE_STATE_NONE });
    if (hasPlate) {
        await page.getByPlaceholder('Enter plate #').fill(entry.plate.trim());
    }

    await page.getByPlaceholder('Enter notes').fill(notes);
    await page.getByPlaceholder('Geolocation (preferred)').fill(`${entry.lat}, ${entry.lng}`);
    await page.locator('select').nth(2).selectOption({ label: METRO_CITY_DETROIT });

    // The date field is a read-only custom calendar widget (fill() doesn't
    // work -- "element is not editable"). Each day cell is a <td
    // aria-label="August 1">, so select by that once the right month is
    // showing; the header's month-nav buttons live in a div containing the
    // month-name label (.FRQP0u), first/last child = prev/next.
    const takenAt = entry.photoTakenAt ? new Date(entry.photoTakenAt) : new Date();
    try {
        // force: true -- a stray overlay div (donation banner, most likely;
        // dismissOverlays' close-button match isn't catching it every time)
        // was observed intercepting pointer events on this exact field.
        await page.getByPlaceholder('Select date').click({ force: true });
        await page.waitForTimeout(500);

        const targetMonth = takenAt.toLocaleDateString('en-US', { month: 'long' });
        const targetYear = String(takenAt.getFullYear());
        const monthNavGroup = page.locator('.FRQP0u');
        for (let i = 0; i < 24; i++) {
            const shownMonth = (await monthNavGroup.locator('div').innerText()).trim();
            const shownYear = (await page.locator('.GZEhm3 button', { hasText: /^\d{4}$/ }).innerText()).trim();
            if (shownMonth === targetMonth && shownYear === targetYear) break;
            const shownDate = new Date(`${shownMonth} 1, ${shownYear}`);
            const targetFirstOfMonth = new Date(`${targetMonth} 1, ${targetYear}`);
            const goingBack = shownDate > targetFirstOfMonth;
            await monthNavGroup.locator('button').nth(goingBack ? 0 : 1).click();
            await page.waitForTimeout(150);
            if (i === 23) throw new Error(`Calendar navigation didn't reach ${targetMonth} ${targetYear}`);
        }

        const dayLabel = takenAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        await page.locator(`td[aria-label="${dayLabel}"]`).click();
    } catch (err) {
        await debugDump(page, 'date-picker-failed');
        throw err;
    }

    // The time field ("--:-- AM" with spinner arrows, type="tel") looks
    // like a segmented hour/minute/AM-PM input rather than a popup list --
    // try typing the digits directly after focusing it.
    try {
        await page.getByLabel('Time Picker').click({ force: true });
        await page.waitForTimeout(200);
        let hour12 = takenAt.getHours() % 12;
        if (hour12 === 0) hour12 = 12;
        const hh = String(hour12).padStart(2, '0');
        const mm = String(takenAt.getMinutes()).padStart(2, '0');
        const ampm = takenAt.getHours() >= 12 ? 'PM' : 'AM';
        await page.keyboard.type(`${hh}${mm}${ampm}`, { delay: 50 });
        await page.waitForTimeout(300);
        await debugDump(page, 'time-picker-typed');
        throw new Error('time picker typing checkpoint -- see debug-time-picker-typed.png');
    } catch (err) {
        if (!/typing checkpoint/.test(err.message)) await debugDump(page, 'time-picker-failed');
        throw err;
    }

    // crashOccurred intentionally left unchecked -- these are obstruction
    // reports, not crash reports.
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const email = process.env.BLU_EMAIL;
    const password = process.env.BLU_PASSWORD;
    if (!email || !password) {
        console.error('Set BLU_EMAIL and BLU_PASSWORD environment variables.');
        process.exit(1);
    }

    const serviceAccount = loadServiceAccount(args);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    const user = await admin.auth().getUserByEmail(args.email);
    const db = admin.firestore();
    const collection = db.collection('users').doc(user.uid).collection('history');

    const snapshot = await collection.where('bluStatus', '==', 'pending').limit(args.limit).get();
    if (snapshot.empty) {
        console.log('No pending BLU submissions.');
        return;
    }
    console.log(`Found ${snapshot.size} pending submission(s).`);

    const dryRunDir = path.join(__dirname, 'dry-run');
    if (args.dryRun) fs.mkdirSync(dryRunDir, { recursive: true });

    const browser = await chromium.launch({ headless: !args.headed });
    const page = await browser.newPage();

    // Diagnostic logging: the login click was observed to enter a
    // disabled/loading state and never resolve in CI -- log the actual
    // login network response and any console errors so we can tell a slow
    // request from a rejected one instead of guessing further.
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`  [page console error] ${msg.text()}`);
    });
    page.on('response', async (res) => {
        if (/login\.jsw|cognito|captcha|recaptcha/i.test(res.url())) {
            console.log(`  [network] ${res.status()} ${res.url().slice(0, 150)}`);
        }
    });

    try {
        await loginToBlu(page, email, password);
        console.log('Logged into Bike Lane Uprising.');

        for (const doc of snapshot.docs) {
            const issueId = doc.id;
            const entry = doc.data();
            console.log(`Submitting #${issueId}...`);

            if (!entry.photoUrl || entry.lat == null || entry.lng == null) {
                console.warn(`  Skipping #${issueId} -- missing photoUrl/lat/lng (photo upload may have failed).`);
                await doc.ref.set({ bluStatus: 'failed', bluError: 'missing photoUrl/lat/lng' }, { merge: true });
                continue;
            }

            const tempPhotoPath = path.join(os.tmpdir(), `blu-${issueId}.jpg`);
            try {
                await downloadToTempFile(entry.photoUrl, tempPhotoPath);
                const notes = `Incident reported to the City of Detroit as #${issueId}.`;
                await fillSubmitForm(page, entry, tempPhotoPath, notes);

                if (args.dryRun) {
                    const shotPath = path.join(dryRunDir, `${issueId}.png`);
                    await page.screenshot({ path: shotPath, fullPage: true });
                    console.log(`  Dry run -- screenshot saved to ${shotPath}, not submitting.`);
                    continue;
                }

                await page.getByRole('button', { name: /^submit$/i }).first().click();
                await page.getByText(/boom!\s*got it!?/i).waitFor({ state: 'visible', timeout: 20000 });

                await doc.ref.set({ bluStatus: 'submitted', bluSubmittedAt: new Date().toISOString() }, { merge: true });
                console.log(`  Submitted #${issueId}.`);
            } catch (err) {
                console.error(`  Failed to submit #${issueId}: ${err.message}`);
                if (!args.dryRun) {
                    await doc.ref.set({ bluStatus: 'failed', bluError: err.message }, { merge: true });
                }
            } finally {
                fs.rmSync(tempPhotoPath, { force: true });
            }
        }
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
