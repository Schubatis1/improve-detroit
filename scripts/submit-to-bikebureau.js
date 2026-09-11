#!/usr/bin/env node
/**
 * Mirrors pending "You Can't Park There" submissions to Bike Bureau
 * (loudbicycle.com/bb), which has no public API -- this drives the real
 * submit form with Playwright, the same approach used for Bike Lane
 * Uprising (see scripts/submit-to-blu.js). Meant to run on a schedule (see
 * .github/workflows/submit-to-bikebureau.yml); safe to re-run since it only
 * acts on Firestore history entries with bikeBureauStatus == "pending" and
 * always updates that field afterward.
 *
 * Unlike BLU, Bike Bureau's /bb/submit form needs no login and no manual
 * date/plate-state/city fields -- it reads the photo's own EXIF (GPS +
 * taken-at) client-side to place the map pin and populate the gallery, and
 * runs an in-browser AI model to read the plate, so this script only needs
 * to check the Terms checkbox, upload the photo, optionally type the plate
 * as a fallback, and click Submit. Confirmed by manually walking a test
 * upload through the form (then Discard, not Submit) -- see PR description.
 *
 * A signed-out /submit still works (Bike Bureau calls it a "guest" report),
 * but a Cloudflare "Verify you are human" challenge can appear on pretty
 * much any submission -- confirmed via a real run against history entries
 * (roughly 1 in 6 got through clean). This script never solves or bypasses
 * it itself (see CaptchaBlockedError below): in --headed mode it pauses and
 * waits for a human at the keyboard to click the checkbox, then continues;
 * headless, it has no one to do that, so it stops the whole batch rather
 * than burning through the rest one by one. Signing in first to see if that
 * avoids the check was considered, but Google blocks sign-in from any
 * automation-controlled browser outright ("This browser or app may not be
 * secure") regardless of which Chrome build drives it -- not something to
 * route around either, so there's no login step here. --storage-state
 * exists as an escape hatch if you ever get a Bike Bureau session by some
 * other, non-automated means, but there's currently no supported way to
 * produce one.
 *
 * Env vars:
 *   FIREBASE_SERVICE_ACCOUNT_JSON -- the service account key, as a JSON string
 *     (or pass --service-account <path> to read it from a file instead)
 *
 * Usage:
 *   node scripts/submit-to-bikebureau.js [--email you@example.com] [--limit 10]
 *     [--dry-run] [--headed] [--service-account Secrets/serviceAccountKey.json]
 *     [--storage-state scripts/bikebureau-session.json] [--channel chrome]
 *     [--user-data-dir ~/.config/google-chrome]
 *
 *   --channel <name> launches a specific installed browser via Playwright's
 *     channel option (e.g. "chrome" for a real Google Chrome install
 *     instead of the Playwright-bundled Chromium build). Doesn't change how
 *     the Cloudflare check above is handled -- it's still automation-driven
 *     either way -- just which browser binary does the driving.
 *
 *   --user-data-dir <path> uses your actual Chrome profile directory
 *     instead of a fresh throwaway one, so the browser carries your real
 *     history/cookies/extensions -- same reasoning as --channel, unproven
 *     effect on the Cloudflare check, doesn't touch the Google sign-in
 *     block either. Chrome refuses to run two instances against the same
 *     profile at once, so close every regular Chrome window first; you'll
 *     get the profile back when this script exits.
 *
 *   --dry-run fills out each form and screenshots it into
 *     scripts/dry-run-bikebureau/ then clicks Discard report instead of
 *     Submit report, leaving bikeBureauStatus alone. Run this (with
 *     --headed to actually watch it) before trusting the scheduled
 *     workflow, and confirm at least one real non-dry-run submission by
 *     hand -- same as was done for BLU -- before enabling the schedule.
 *
 *   --storage-state <path> loads a saved Playwright storageState (cookies +
 *     localStorage) into the browser context before submitting -- see the
 *     header comment above for why there's currently no supported way to
 *     produce one for this site.
 *
 *   On a Cloudflare "Verify you are human" challenge: --headed waits (up to
 *   5 minutes by default) for you to click it, then continues; headless
 *   stops the whole run immediately (exit code 2) -- see CaptchaBlockedError
 *   below. Either way, whatever didn't get submitted stays 'pending'; just
 *   re-run later (or let the batch keep going after you click through).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const admin = require('firebase-admin');
const { chromium } = require('playwright');

const SUBMIT_URL = 'https://loudbicycle.com/bb/submit';

function parseArgs(argv) {
    const args = { email: 'aschubatis@gmail.com', limit: 10 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--headed') args.headed = true;
        else if (a === '--email') args.email = argv[++i];
        else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
        else if (a === '--service-account') args.serviceAccount = argv[++i];
        else if (a === '--storage-state') args.storageState = argv[++i];
        else if (a === '--channel') args.channel = argv[++i];
        else if (a === '--user-data-dir') args.userDataDir = argv[++i];
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random pause between submissions so requests to Bike Bureau don't land
// back-to-back -- same range as scripts/submit-to-blu.js.
function randomSubmissionDelayMs() {
    const minSeconds = 30;
    const maxSeconds = 121;
    return (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000;
}

// Observed hanging indefinitely with no error and no timeout during setup
// (an idle-but-established connection to Firebase Storage that never
// resolved) -- AbortSignal.timeout so a flaky connection fails loudly
// instead of silently stalling the whole batch forever.
async function downloadToTempFile(url, destPath) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Photo download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

// Thrown when Bike Bureau's Cloudflare "Verify you are human" challenge
// appears and (in --headed mode) isn't clicked through in time, or appears
// at all in headless mode -- this script never attempts to solve it itself
// (see the file header). Caught specially in main(): unlike an ordinary
// per-entry failure, this means every remaining entry in the batch would
// hit the same wall, so the whole run stops instead of burning through the
// rest one by one.
class CaptchaBlockedError extends Error {}

// Checked at a few points in fillSubmitForm/main -- confirmed via a real
// run against history entries that this is where it appears (a "Quick
// security check" panel with "Verify you are human" text, overlapping the
// map): right after the upload panel should be showing, and again right
// before/during the plate fill, since it was observed to render a few
// seconds AFTER an earlier check already passed.
//
// Headless: no one could click it, so this always throws immediately.
// Headed: give a human at the keyboard a chance to solve it themselves --
// poll for the challenge text to go away (they checked the box) for up to
// captchaWaitMs, logging a reminder periodically, before giving up and
// throwing. Solving the box is the human's action, not this script's.
async function checkForCaptcha(page, { headed = false, captchaWaitMs = 5 * 60 * 1000 } = {}) {
    // Cloudflare Turnstile always embeds an iframe (challenges.cloudflare.com)
    // on this page, even when running invisibly -- so its mere presence
    // isn't a signal. Two things confirmed unreliable during setup: (1)
    // page.getByText() only searches the main frame, so text-based
    // detection never matched even with the challenge visibly on screen in
    // a debug screenshot; (2) the iframe has no static `src` attribute
    // (it's assigned via JS), so a CSS attribute selector finds nothing.
    // What's actually reliable regardless of Turnstile's internals
    // (possibly a closed shadow root, which no Playwright API can pierce
    // at all): the iframe ELEMENT's own layout. Invisible/managed mode
    // renders it with no box (confirmed via repeated automated dry runs --
    // boundingBox() came back null every time); the interactive checkbox
    // challenge has to actually take up visible space to be clickable.
    const isBlocked = async () => {
        for (const frame of page.frames()) {
            if (!frame.url().includes('challenges.cloudflare.com')) continue;
            try {
                const el = await frame.frameElement();
                const box = await el.boundingBox();
                if (box && box.height > 10 && box.width > 10) return true;
            } catch {
                // Frame navigated/detached mid-check -- not blocking.
            }
        }
        return false;
    };
    if (!(await isBlocked())) return;

    if (!headed) {
        throw new CaptchaBlockedError('Cloudflare "Verify you are human" challenge appeared -- re-run with --headed to click through it yourself.');
    }

    console.log('  Cloudflare check appeared -- click the "Verify you are human" checkbox in the browser window.');
    const deadline = Date.now() + captchaWaitMs;
    let lastReminder = Date.now();
    while (Date.now() < deadline) {
        if (!(await isBlocked())) {
            console.log('  Thanks -- continuing.');
            return;
        }
        if (Date.now() - lastReminder > 30000) {
            console.log('  Still waiting on the Cloudflare check...');
            lastReminder = Date.now();
        }
        await page.waitForTimeout(1000);
    }
    throw new CaptchaBlockedError(`Cloudflare "Verify you are human" challenge wasn't cleared within ${Math.round(captchaWaitMs / 1000)}s.`);
}

async function debugDump(page, label) {
    const dir = path.join(__dirname, 'dry-run-bikebureau');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `debug-${label}.png`), fullPage: true }).catch(() => {});
    const buttons = await page.locator('button, [role="button"], a').evaluateAll((els) =>
        els.slice(0, 60).map((el) => (el.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
    ).catch(() => []);
    fs.writeFileSync(path.join(dir, `debug-${label}-buttons.json`), JSON.stringify(buttons, null, 2));
}

async function fillSubmitForm(page, entry, photoPath, headed) {
    await page.goto(SUBMIT_URL, { waitUntil: 'domcontentloaded' });

    // The Terms checkbox (#homeTermsCheckbox) gates the upload dropzone --
    // it's absent/inert until checked. It's a visually-hidden native input
    // (a styled overlay is the clickable box a user sees), confirmed via a
    // DOM dump during setup -- Playwright's default actionability check
    // (and picking `input[type="checkbox"]` by position, which also risked
    // matching #homeCaptureModeCheckbox, an unrelated checkbox on the same
    // page) both failed against it, hence the explicit id + force.
    //
    // Bike Bureau remembers the agreement client-side (confirmed via
    // repeated loads in the same browser context) -- after the first
    // report in a run, later /submit loads skip the checkbox entirely and
    // go straight to the upload dropzone, so this is best-effort: check it
    // when present, move on when it's already been satisfied.
    try {
        await page.locator('#homeTermsCheckbox').waitFor({ state: 'attached', timeout: 5000 });
        await page.locator('#homeTermsCheckbox').check({ force: true });
    } catch {
        const stillNoUpload = await page.locator('input[type="file"]').count() === 0;
        if (stillNoUpload) {
            await debugDump(page, 'terms-checkbox-not-found');
            throw new Error('Terms checkbox not found and no upload dropzone appeared either');
        }
    }

    // entry.lat/entry.lng aren't sent explicitly -- the form reads GPS
    // straight from the uploaded photo's own EXIF (same photo the app
    // geocoded client-side when the report was first filed), so the map
    // pin lands in the right place without this script touching it.
    await page.locator('input[type="file"]').first().setInputFiles(photoPath);

    try {
        await page.getByRole('button', { name: /^submit report$/i }).waitFor({ state: 'visible', timeout: 30000 });
    } catch (err) {
        await checkForCaptcha(page, { headed }); // a more specific reason than the generic timeout, if this is why
        await debugDump(page, 'submit-panel-not-found');
        throw err;
    }
    await checkForCaptcha(page, { headed }); // the challenge can appear alongside the panel, not just instead of it

    // Best-effort only -- Bike Bureau's own in-browser AI model usually
    // reads the plate from the photo, this is just a fallback so a report
    // isn't missing a plate the app already had on file. Some older
    // entries have the literal string "Unknown" in entry.plate (confirmed
    // via a real one during setup) -- that's a "no plate visible" marker
    // from this app's own data, not an actual plate, so don't type it.
    if (entry.plate && entry.plate.trim() && entry.plate.trim().toLowerCase() !== 'unknown') {
        // A single long fill() with a 30s timeout was observed to mask the
        // Cloudflare challenge: it can render a few seconds AFTER the
        // checkForCaptcha() call above already passed (an invisible overlay
        // that blocks the field without changing what's on screen at first
        // glance), so the fill just times out generically instead of
        // hitting the specific, batch-stopping CaptchaBlockedError below.
        // Short retries with a check in between catch it as soon as it
        // appears instead of only before/after.
        let filled = false;
        let lastErr;
        for (let attempt = 0; attempt < 6 && !filled; attempt++) {
            try {
                await page.getByPlaceholder('type plate here').fill(entry.plate.trim(), { timeout: 5000 });
                filled = true;
            } catch (err) {
                lastErr = err;
                await checkForCaptcha(page, { headed });
                await page.waitForTimeout(500);
            }
        }
        if (!filled) {
            await debugDump(page, 'plate-field-not-found');
            throw lastErr;
        }
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const serviceAccount = loadServiceAccount(args);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    const user = await admin.auth().getUserByEmail(args.email);
    const db = admin.firestore();
    const collection = db.collection('users').doc(user.uid).collection('history');

    const snapshot = await collection.where('bikeBureauStatus', '==', 'pending').limit(args.limit).get();
    if (snapshot.empty) {
        console.log('No pending Bike Bureau submissions.');
        return;
    }
    console.log(`Found ${snapshot.size} pending submission(s).`);

    const dryRunDir = path.join(__dirname, 'dry-run-bikebureau');
    if (args.dryRun) fs.mkdirSync(dryRunDir, { recursive: true });

    // --user-data-dir launches your actual Chrome profile (launchPersistentContext
    // returns the context directly -- there's no separate browser handle to
    // close, just the context) instead of a fresh throwaway one. Chrome
    // refuses to run two instances against the same profile directory at
    // once, so this needs your regular Chrome fully closed first.
    const usingRealProfile = !!args.userDataDir;
    const context = usingRealProfile
        ? await chromium.launchPersistentContext(path.resolve(args.userDataDir), {
            headless: !args.headed,
            channel: args.channel,
            // Playwright's default 180s launch timeout wasn't enough for a
            // real, fully-loaded profile during setup -- it was still
            // retrying GCM push registration (DEPRECATED_ENDPOINT, unrelated
            // to anything this script does) every ~20s past that point.
            timeout: 300000,
        })
        : await (await chromium.launch({ headless: !args.headed, channel: args.channel })).newContext(
            args.storageState ? { storageState: path.resolve(args.storageState) } : {}
        );
    const page = usingRealProfile ? (context.pages()[0] || await context.newPage()) : await context.newPage();

    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`  [page console error] ${msg.text()}`);
    });

    let stopBatch = false;
    let stopReason = '';
    let processed = 0;
    try {
        for (const [index, doc] of snapshot.docs.entries()) {
            const issueId = doc.id;
            const entry = doc.data();
            console.log(`Submitting #${issueId}...`);

            if (!entry.photoUrl) {
                console.warn(`  Skipping #${issueId} -- missing photoUrl (photo upload may have failed).`);
                await doc.ref.set({ bikeBureauStatus: 'failed', bikeBureauError: 'missing photoUrl' }, { merge: true });
                continue;
            }

            const tempPhotoPath = path.join(os.tmpdir(), `bikebureau-${issueId}.jpg`);
            try {
                await downloadToTempFile(entry.photoUrl, tempPhotoPath);
                await fillSubmitForm(page, entry, tempPhotoPath, args.headed);

                if (args.dryRun) {
                    const shotPath = path.join(dryRunDir, `${issueId}.png`);
                    await page.screenshot({ path: shotPath, fullPage: true });
                    console.log(`  Dry run -- screenshot saved to ${shotPath}, discarding instead of submitting.`);
                    await page.getByRole('button', { name: /^discard report$/i }).click();
                    continue;
                }

                await checkForCaptcha(page, { headed: args.headed }); // one last check -- it can render in the gap between filling the form and clicking Submit
                await page.getByRole('button', { name: /^submit report$/i }).click();
                await page.getByRole('button', { name: /^submit report$/i }).waitFor({ state: 'hidden', timeout: 20000 });

                await doc.ref.set({ bikeBureauStatus: 'submitted', bikeBureauSubmittedAt: new Date().toISOString() }, { merge: true });
                console.log(`  Submitted #${issueId}.`);
                processed++;

                if (index < snapshot.docs.length - 1) {
                    const delayMs = randomSubmissionDelayMs();
                    console.log(`  Pausing ${Math.round(delayMs / 1000)}s before next submission...`);
                    await sleep(delayMs);
                }
            } catch (err) {
                if (err instanceof CaptchaBlockedError) {
                    // Deliberately NOT marked 'failed' -- nothing about this
                    // entry was wrong, every remaining one would hit the same
                    // wall. Left 'pending' so a later run picks it straight
                    // back up (or, in --headed mode, this only throws after
                    // the wait-for-a-human-to-click window already expired).
                    console.error(`  Blocked by Cloudflare's "Verify you are human" check on #${issueId}${args.headed ? ' (not cleared in time)' : ''} -- stopping here rather than burning through the rest of the batch.`);
                    if (!args.headed) console.error(`  Re-run with --headed to click through it yourself when it appears.`);
                    stopBatch = true;
                    stopReason = args.headed ? "the Cloudflare check wasn't cleared in time" : 'the Cloudflare check appeared';
                } else if (page.isClosed() || /Target page, context or browser has been closed/.test(err.message)) {
                    // The browser/tab died (crashed, or you closed the
                    // window) -- every remaining entry in this run would
                    // fail the exact same way for a reason that has nothing
                    // to do with any of them, so stop instead of marking the
                    // whole rest of the batch 'failed' one by one (this
                    // happened for real once during setup -- 59 entries
                    // wrongly marked before the bug was caught and reverted).
                    console.error(`  Browser/tab closed unexpectedly on #${issueId} -- stopping here. Re-run to pick up where this left off.`);
                    stopBatch = true; // reuses the same "stop, don't mark failed" path below
                    stopReason = 'the browser/tab closed unexpectedly';
                } else {
                    console.error(`  Failed to submit #${issueId}: ${err.message}`);
                    if (!args.dryRun) {
                        await doc.ref.set({ bikeBureauStatus: 'failed', bikeBureauError: err.message }, { merge: true });
                    }
                }
            } finally {
                fs.rmSync(tempPhotoPath, { force: true });
            }
            if (stopBatch) break;
        }
    } finally {
        await context.close();
    }

    if (stopBatch) {
        console.log(`\nStopped early: ${processed}/${snapshot.size} submitted this run before ${stopReason}. The rest are still 'pending' -- just re-run this script to pick up where it left off.`);
        process.exitCode = 2;
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { parseArgs, randomSubmissionDelayMs };
