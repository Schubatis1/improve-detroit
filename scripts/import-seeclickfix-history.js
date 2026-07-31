#!/usr/bin/env node
/**
 * One-time import: pulls this account's SeeClickFix submission history out
 * of a HAR capture (Chrome DevTools -> Network -> right-click -> "Save all
 * as HAR with content" while browsing seeclickfix.com/profile) and writes
 * it into Firestore at users/{uid}/history, in the same shape the app
 * itself writes via addToHistory() in index.html.
 *
 * Requires:
 *   1. You've signed into the app with Google at least once (creates the
 *      Firebase Auth user this script looks up by email).
 *   2. A Firebase service account key JSON (Firebase console -> Project
 *      settings -> Service accounts -> Generate new private key).
 *
 * Usage:
 *   node scripts/import-seeclickfix-history.js \
 *     --har Secrets/seeclickfix.com.har \
 *     --service-account Secrets/serviceAccountKey.json \
 *     --email aschubatis@gmail.com
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function parseArgs(argv) {
    const args = { email: 'aschubatis@gmail.com' };
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        args[key] = argv[i + 1];
    }
    return args;
}

function readHarJson(entry) {
    const content = entry.response.content;
    let text = content.text || '';
    if (content.encoding === 'base64') text = Buffer.from(text, 'base64').toString('utf8');
    return JSON.parse(text);
}

function loadIssuesFromHar(harPath) {
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    const entries = har.log.entries.filter((e) => e.request.url.includes('/api/v2/profile/issues'));
    const issuesById = new Map();
    for (const entry of entries) {
        let data;
        try {
            data = readHarJson(entry);
        } catch (err) {
            console.warn(`Skipping unparseable entry ${entry.request.url}: ${err.message}`);
            continue;
        }
        for (const issue of data.issues || []) {
            issuesById.set(issue.id, issue);
        }
    }
    return [...issuesById.values()];
}

function toHistoryEntry(issue) {
    const thumbnail = (issue.media && (issue.media.image_square_100x100 || issue.media.representative_image_url)) || '';
    return {
        thumbnail,
        address: issue.address || '',
        submittedAt: issue.created_at || new Date().toISOString(),
        status: issue.status || 'Unknown',
        link: issue.html_url || `https://seeclickfix.com/issues/${issue.id}`,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.har || !args['service-account']) {
        console.error('Usage: node scripts/import-seeclickfix-history.js --har <path.har> --service-account <key.json> [--email you@example.com]');
        process.exit(1);
    }

    const harPath = path.resolve(args.har);
    const serviceAccountPath = path.resolve(args['service-account']);

    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

    const user = await admin.auth().getUserByEmail(args.email);
    console.log(`Importing into uid ${user.uid} (${args.email})`);

    const issues = loadIssuesFromHar(harPath);
    console.log(`Found ${issues.length} unique issues in ${harPath}`);

    const db = admin.firestore();
    const collection = db.collection('users').doc(user.uid).collection('history');

    let batch = db.batch();
    let opsInBatch = 0;
    let written = 0;
    for (const issue of issues) {
        const docRef = collection.doc(String(issue.id));
        batch.set(docRef, toHistoryEntry(issue), { merge: true });
        opsInBatch++;
        written++;
        if (opsInBatch === 450) {
            await batch.commit();
            batch = db.batch();
            opsInBatch = 0;
        }
    }
    if (opsInBatch > 0) await batch.commit();

    console.log(`Wrote ${written} history entries to users/${user.uid}/history`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
