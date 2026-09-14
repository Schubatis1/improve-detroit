#!/usr/bin/env node
/**
 * One-time (idempotent -- uses .set() with merge:false only on first write,
 * skips ids that already have a history doc) recovery script: reconstructs
 * users/{uid}/history docs for real SeeClickFix tickets that never made it
 * into history because addToHistory() silently hung (see the makeThumbnail
 * onerror fix -- a photo the browser failed to decode left that promise
 * unresolved forever, so the ticket got filed but its history entry never
 * got written, with no error anywhere).
 *
 * Pulls what it can from SeeClickFix's public issue API (address, lat/lng,
 * status, link, description, a thumbnail) -- there is no way to recover the
 * plate/vehicle/company/USDOT text that would have been typed into the
 * report card, since SeeClickFix's public API doesn't expose the answer
 * text and the original browser session is long gone. Those fields are
 * left empty rather than guessed. bluCategory similarly falls back to the
 * same default the app itself uses when nothing more specific is known
 * (config.js's bluCategories[0]).
 *
 * The photo itself is re-hosted: downloaded from SeeClickFix's CDN and
 * re-uploaded to Firebase Storage at history/{uid}/{issueId}.jpg, with a
 * download-token URL built the same way the client SDK's getDownloadURL()
 * would, so bluStatus/bikeBureauStatus can stay "pending" and the normal
 * scheduled BLU/Bike Bureau mirroring picks these up exactly like any other
 * report -- rather than relying on SeeClickFix's own CDN link staying
 * reachable indefinitely.
 *
 * Requires a Firebase service account key JSON (Firebase console ->
 * Project settings -> Service accounts -> Generate new private key).
 *
 * Usage:
 *   node scripts/backfill-missing-history.js \
 *     --service-account Secrets/serviceAccountKey.json \
 *     --issue-ids 22771843,22771973 \
 *     --email aschubatis@gmail.com
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

function parseArgs(argv) {
    const args = { email: 'aschubatis@gmail.com' };
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        args[key] = argv[i + 1];
    }
    return args;
}

async function fetchIssue(issueId) {
    const res = await fetch(`https://seeclickfix.com/api/v2/issues/${issueId}`);
    if (!res.ok) throw new Error(`SeeClickFix lookup for #${issueId} failed: HTTP ${res.status}`);
    return res.json();
}

async function fetchBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Photo download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

// Builds the same https://firebasestorage.googleapis.com/... download URL
// the client SDK's getDownloadURL() would return, so entries backfilled
// here work identically to ones the app wrote itself (see addToHistory).
async function uploadPhotoAndGetDownloadUrl(bucket, uid, issueId, buffer) {
    const objectPath = `history/${uid}/${issueId}.jpg`;
    const token = crypto.randomUUID();
    const file = bucket.file(objectPath);
    await file.save(buffer, {
        contentType: 'image/jpeg',
        metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

function toHistoryEntry(issue, photoUrl, thumbnail, fallbackBluCategory) {
    return {
        thumbnail,
        address: issue.address || '',
        submittedAt: issue.created_at || new Date().toISOString(),
        status: issue.status || 'Open',
        link: issue.html_url || `https://seeclickfix.com/issues/${issue.id}`,
        suppressed: false,
        geofenceId: null,
        lat: issue.lat != null ? issue.lat : null,
        lng: issue.lng != null ? issue.lng : null,
        metroCity: 'Detroit - MI',
        plate: null,
        plateIds: [],
        companyName: null,
        companyIds: [],
        usdotNumber: null,
        usdotIds: [],
        photoTakenAt: null,
        bluCategory: fallbackBluCategory,
        category: 'vehicle',
        description: issue.description || '',
        bluStatus: 'pending',
        bikeBureauStatus: 'pending',
        photoUrl,
        // Marks this doc as reconstructed after the fact rather than
        // written live by addToHistory, in case that distinction ever
        // matters for troubleshooting later.
        backfilledAt: new Date().toISOString(),
        backfilledReason: 'makeThumbnail hung with no onerror handler -- see index.html 3.47.3 release notes',
    };
}

// Split out from main() so it's testable without real network/Storage
// access -- see test/scripts.integration.test.js.
async function backfillMissingHistory(db, bucket, uid, issueIds, fallbackBluCategory, deps = {}) {
    const doFetchIssue = deps.fetchIssue || fetchIssue;
    const doFetchBuffer = deps.fetchBuffer || fetchBuffer;
    const doUpload = deps.uploadPhotoAndGetDownloadUrl || uploadPhotoAndGetDownloadUrl;

    const collection = db.collection('users').doc(uid).collection('history');
    const results = [];
    for (const issueId of issueIds) {
        const docRef = collection.doc(String(issueId));
        const existing = await docRef.get();
        if (existing.exists) {
            console.log(`#${issueId}: history doc already exists -- skipping.`);
            results.push({ issueId, skipped: true });
            continue;
        }

        console.log(`#${issueId}: fetching from SeeClickFix...`);
        const issue = await doFetchIssue(issueId);

        const thumbUrl = (issue.media && (issue.media.image_square_100x100 || issue.media.representative_image_url)) || null;
        const fullUrl = (issue.media && (issue.media.image_full || issue.media.representative_image_url)) || null;

        let photoUrl = null;
        let thumbnail = '';
        if (fullUrl) {
            console.log(`#${issueId}: downloading and re-hosting photo...`);
            const buffer = await doFetchBuffer(fullUrl);
            photoUrl = await doUpload(bucket, uid, issueId, buffer);
        }
        if (thumbUrl) {
            const thumbBuffer = await doFetchBuffer(thumbUrl);
            thumbnail = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
        }

        const entry = toHistoryEntry(issue, photoUrl, thumbnail, fallbackBluCategory);
        await docRef.set(entry);
        console.log(`#${issueId}: history doc written (${entry.address}).`);
        results.push({ issueId, skipped: false, entry });
    }
    return results;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args['service-account'] || !args['issue-ids']) {
        console.error('Usage: node scripts/backfill-missing-history.js --service-account <key.json> --issue-ids 123,456 [--email you@example.com]');
        process.exit(1);
    }

    const serviceAccountPath = path.resolve(args['service-account']);
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: 'improve-detroit.firebasestorage.app',
    });

    const user = await admin.auth().getUserByEmail(args.email);
    console.log(`Backfilling history for uid ${user.uid} (${args.email})`);

    const issueIds = args['issue-ids'].split(',').map((s) => s.trim()).filter(Boolean);
    const db = admin.firestore();
    const bucket = admin.storage().bucket();
    // Same fallback the live app uses (config.js's bluCategories[0]) when
    // nothing more specific is known -- see index.html:1645.
    const fallbackBluCategory = 'Private Owner Vehicle';

    await backfillMissingHistory(db, bucket, user.uid, issueIds, fallbackBluCategory);
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { parseArgs, fetchIssue, fetchBuffer, uploadPhotoAndGetDownloadUrl, toHistoryEntry, backfillMissingHistory };
