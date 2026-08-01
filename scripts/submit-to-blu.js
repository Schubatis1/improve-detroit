#!/usr/bin/env node
/**
 * Mirrors pending "You Can't Park Here" submissions to Bike Lane Uprising
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

async function loginToBlu(page, email, password) {
    await page.goto(SUBMIT_URL, { waitUntil: 'networkidle' });

    const alreadyLoggedIn = await page.getByRole('button', { name: /log out/i }).count();
    if (alreadyLoggedIn > 0) return;

    await page.getByRole('button', { name: /login\s*\/\s*sign up/i }).first().click();
    await page.locator('input[type="email"]').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: /log in/i }).first().click();
    await page.getByRole('button', { name: /log out/i }).first().waitFor({ state: 'visible', timeout: 20000 });
}

async function fillSubmitForm(page, entry, photoPath, notes) {
    await page.goto(SUBMIT_URL, { waitUntil: 'networkidle' });

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

    const takenAt = entry.photoTakenAt ? new Date(entry.photoTakenAt) : new Date();
    const dateStr = `${takenAt.getMonth() + 1}/${takenAt.getDate()}/${takenAt.getFullYear()}`;
    const timeStr = takenAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    await page.getByPlaceholder('Select date').fill(dateStr);
    await page.getByPlaceholder('Select date').press('Escape');
    await page.getByLabel('Time Picker').fill(timeStr);
    await page.getByLabel('Time Picker').press('Escape');

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
                await doc.ref.set({ bluStatus: 'failed', bluError: err.message }, { merge: true });
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
