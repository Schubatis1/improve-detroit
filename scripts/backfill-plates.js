#!/usr/bin/env node
/**
 * One-time (idempotent, safe to re-run) backfill: computes plateIds for
 * every existing users/{uid}/history doc and upserts the corresponding
 * users/{uid}/plates/{plateId} index docs, so history logged before the
 * plates index existed shows up in it too. Not required for the app to
 * work correctly -- getPriorComplaintsForPlate/renderOffenders/renderStats
 * in index.html already fall back to scanning history directly for
 * anything the index doesn't have -- this just makes lookups against old
 * data as cheap as lookups against new data, and gives the index full
 * historical coverage.
 *
 * plateDocId/parsePlateIds below must stay logically identical to
 * index.html's -- they're duplicated here rather than shared because this
 * runs under Node with firebase-admin, not in the browser.
 *
 * Requires a Firebase service account key JSON (Firebase console ->
 * Project settings -> Service accounts -> Generate new private key).
 *
 * Usage:
 *   node scripts/backfill-plates.js \
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

function normalizePlate(plate) {
    return String(plate || '').toUpperCase().replace(/\s+/g, '');
}

function plateDocId(plate) {
    return normalizePlate(plate).replace(/\//g, '-');
}

function parsePlateIds(rawPlate) {
    return [...new Set(String(rawPlate || '').split(',').map(plateDocId).filter(Boolean))];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args['service-account']) {
        console.error('Usage: node scripts/backfill-plates.js --service-account <key.json> [--email you@example.com]');
        process.exit(1);
    }

    const serviceAccountPath = path.resolve(args['service-account']);
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

    const user = await admin.auth().getUserByEmail(args.email);
    console.log(`Backfilling plates index for uid ${user.uid} (${args.email})`);

    const db = admin.firestore();
    const historySnapshot = await db.collection('users').doc(user.uid).collection('history').get();
    console.log(`Found ${historySnapshot.size} history docs`);

    let batch = db.batch();
    let opsInBatch = 0;
    let historyDocsTouched = 0;
    let plateDocsTouched = 0;

    for (const doc of historySnapshot.docs) {
        const issueId = doc.id;
        const data = doc.data();
        const plateIds = parsePlateIds(data.plate);
        if (plateIds.length === 0) continue;

        // Only rewrite the history doc if plateIds is actually missing/stale,
        // so a re-run doesn't touch docs that are already correct.
        const existingIds = Array.isArray(data.plateIds) ? data.plateIds.slice().sort() : null;
        const computedIds = plateIds.slice().sort();
        const needsUpdate = !existingIds || existingIds.length !== computedIds.length
            || existingIds.some((id, i) => id !== computedIds[i]);
        if (needsUpdate) {
            batch.set(doc.ref, { plateIds }, { merge: true });
            opsInBatch++;
            historyDocsTouched++;
        }

        for (const plateId of plateIds) {
            const plateRef = db.collection('users').doc(user.uid).collection('plates').doc(plateId);
            batch.set(plateRef, {
                plate: plateId,
                incidentIds: admin.firestore.FieldValue.arrayUnion(issueId),
            }, { merge: true });
            opsInBatch++;
            plateDocsTouched++;
        }

        if (opsInBatch >= 400) {
            await batch.commit();
            batch = db.batch();
            opsInBatch = 0;
        }
    }
    if (opsInBatch > 0) await batch.commit();

    console.log(`Updated plateIds on ${historyDocsTouched} history doc(s)`);
    console.log(`Upserted ${plateDocsTouched} plate-index write(s)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
