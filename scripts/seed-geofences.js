#!/usr/bin/env node
/**
 * One-time (idempotent, safe to re-run -- uses .set(), not .create()) seed
 * of users/{uid}/geofences with the starting geofence set. Geofences used
 * to be a static array in config.js; they're now fully managed from the
 * app itself (see index.html's Geofence Maintenance screen), so getting
 * the first ones in requires either using that screen by hand or running
 * this script once against a fresh Firebase project.
 *
 * Re-running this script overwrites (via merge) only the ids below -- it
 * will NOT touch or delete any geofence you've since added/edited from the
 * app. If you've already edited "gar-building", "times-square", or
 * "little-caesars-arena" from the app, re-running this script will stomp
 * those edits back to the defaults below -- check before re-running.
 *
 * Requires a Firebase service account key JSON (Firebase console ->
 * Project settings -> Service accounts -> Generate new private key).
 *
 * Usage:
 *   node scripts/seed-geofences.js \
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

// Kept in sync by hand with index.html's geofence document shape --
// see resolveWorkflow/geofenceActiveAt and the Geofence Maintenance screen.
const GEOFENCES = [
    {
        id: 'gar-building',
        name: 'GAR Building valet staging (Sexy Steak)',
        lat: 42.33494474658147,
        lng: -83.05480479874544,
        radiusMeters: 100,
        message: 'Valet operator at the GAR Building (Sexy Steak, 1942 Grand River) is using the Grand River bicycle lane as a staging area, blocking the bike lane. This is a recurring problem -- see previous {{PRIOR_COMPLAINTS}}.',
        bluCategory: 'Company Vehicle',
        improveDetroitCategory: '', // '' = use the schema default (see pickDefaultNatureValue)
        // Only active after 2pm, every day -- the valet doesn't stage cars
        // there earlier in the day. endHour null = runs to end of day.
        daysOfWeek: [],
        startHour: 14,
        endHour: null,
        detectRepeatOffenders: true,
        reportRepeatOffenders: true,
        detectRepeatIncidents: true,
        reportRepeatIncidents: true,
    },
    {
        id: 'times-square',
        name: 'Times Square (Cass & Times Square)',
        lat: 42.33273028080044,
        lng: -83.05313484015257,
        radiusMeters: 35,
        message: 'Vehicle parked across bicycle lane and hatched road marking at corner of Cass and Times Square. Please note this is a recurring incident. Please see previous {{PRIOR_COMPLAINTS}}.',
        bluCategory: 'Private Owner Vehicle',
        improveDetroitCategory: '',
        // 24/7 -- no day/hour restriction.
        daysOfWeek: [],
        startHour: null,
        endHour: null,
        detectRepeatOffenders: true,
        reportRepeatOffenders: true,
        detectRepeatIncidents: true,
        reportRepeatIncidents: true,
    },
    {
        id: 'little-caesars-arena',
        name: 'Little Caesars Arena',
        // Quadrilateral (polygon), not a circle -- see index.html's
        // geofenceContainsPoint/pointInPolygon. lat/lng below is just the
        // polygon's centroid (used for map centering/list display); actual
        // matching uses the `polygon` vertices, in order.
        lat: 42.34062822,
        lng: -83.05787565,
        radiusMeters: null,
        polygon: [
            { lat: 42.3389550, lng: -83.0573937 },
            { lat: 42.3396722, lng: -83.0569015 },
            { lat: 42.3420456, lng: -83.0583073 },
            { lat: 42.3418401, lng: -83.0589001 },
        ],
        message: '',
        bluCategory: null,
        improveDetroitCategory: '',
        // Only active after 4pm, every day -- endHour null = runs to end of day.
        daysOfWeek: [],
        startHour: 16,
        endHour: null,
        detectRepeatOffenders: true,
        reportRepeatOffenders: true,
        detectRepeatIncidents: true,
        reportRepeatIncidents: true,
    },
];

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args['service-account']) {
        console.error('Usage: node scripts/seed-geofences.js --service-account <key.json> [--email you@example.com]');
        process.exit(1);
    }

    const serviceAccountPath = path.resolve(args['service-account']);
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

    const user = await admin.auth().getUserByEmail(args.email);
    const db = admin.firestore();
    const collection = db.collection('users').doc(user.uid).collection('geofences');

    for (const { id, ...data } of GEOFENCES) {
        await collection.doc(id).set(data, { merge: true });
        console.log(`Seeded geofence "${id}" (${data.name}).`);
    }

    console.log(`Done. Seeded ${GEOFENCES.length} geofence(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
