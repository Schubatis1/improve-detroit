#!/usr/bin/env node
/**
 * Tags existing Firestore history entries with a geofenceId, so
 * getPriorComplaintIdsForGeofence() in index.html picks them up as prior
 * complaints for that geofence's recurring-issue workflow. Reports
 * submitted going forward are tagged automatically by the app itself
 * (addToHistory) -- this script is only for backfilling reports that
 * predate that (e.g. ones pulled in by import-seeclickfix-history.js, or
 * ones submitted before geofence tagging existed).
 *
 * Usage:
 *   node scripts/tag-geofence.js \
 *     --service-account Secrets/serviceAccountKey.json \
 *     --email aschubatis@gmail.com \
 *     --geofence gar-building \
 *     --issue-ids 22083192,22184122,22211206
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args['service-account'] || !args.geofence || !args['issue-ids']) {
        console.error('Usage: node scripts/tag-geofence.js --service-account <key.json> --geofence <id> --issue-ids <id1,id2,...> [--email you@example.com]');
        process.exit(1);
    }

    const serviceAccountPath = path.resolve(args['service-account']);
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

    const user = await admin.auth().getUserByEmail(args.email);
    const issueIds = args['issue-ids'].split(',').map((s) => s.trim()).filter(Boolean);

    const db = admin.firestore();
    const collection = db.collection('users').doc(user.uid).collection('history');

    let tagged = 0;
    for (const issueId of issueIds) {
        const docRef = collection.doc(issueId);
        const doc = await docRef.get();
        if (!doc.exists) {
            console.warn(`No history entry for issue #${issueId} -- skipping (import it first if it's not in Firestore yet).`);
            continue;
        }
        await docRef.set({ geofenceId: args.geofence }, { merge: true });
        console.log(`Tagged #${issueId} with geofenceId "${args.geofence}"`);
        tagged++;
    }

    console.log(`Done. Tagged ${tagged}/${issueIds.length} issue(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
