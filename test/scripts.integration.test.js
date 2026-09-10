// Integration tests for the Firestore-writing "core" logic pulled out of
// each scripts/*.js main() (see backfillPlates/seedGeofences/
// tagGeofenceOnIssues/importIssues) -- the part of each script that was
// previously untested (only pure helpers like parseArgs had coverage).
// Runs against the Firestore emulator directly via firebase-admin
// (connected via FIRESTORE_EMULATOR_HOST), the same way these scripts talk
// to Firestore in production -- the Admin SDK always bypasses
// firestore.rules, so no Auth emulator/service account is needed, a uid
// string is enough. Requires the emulator: run via `npm run test:rules`
// (which now covers rules + these), not `npm test`.
const admin = require('firebase-admin');
const { backfillPlates } = require('../scripts/backfill-plates.js');
const { seedGeofences, GEOFENCES } = require('../scripts/seed-geofences.js');
const { tagGeofenceOnIssues } = require('../scripts/tag-geofence.js');
const { importIssues } = require('../scripts/import-seeclickfix-history.js');

const PROJECT_ID = 'improve-detroit-scripts-integration-test';
const UID = 'test-uid';

let app;
let db;

beforeAll(() => {
    app = admin.initializeApp({ projectId: PROJECT_ID }, 'scripts-integration-test');
    db = app.firestore();
});

afterAll(async () => {
    await app.delete();
});

afterEach(async () => {
    // Firestore emulator has no bulk-delete API from the client SDK --
    // sweep every collection this suite touches between tests so they
    // don't see each other's documents.
    for (const collection of ['history', 'plates', 'geofences']) {
        const snapshot = await db.collection('users').doc(UID).collection(collection).get();
        await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
});

describe('backfillPlates', () => {
    it('computes plateIds and upserts the plates index for history docs missing it', async () => {
        await db.collection('users').doc(UID).collection('history').doc('issue1').set({ plate: 'ABC 123, xyz 999' });
        await db.collection('users').doc(UID).collection('history').doc('issue2').set({ plate: 'ABC123' });

        const result = await backfillPlates(db, admin.firestore.FieldValue.arrayUnion, UID);
        expect(result.historyDocsTouched).toBe(2);
        expect(result.plateDocsTouched).toBe(3); // issue1: 2 plates, issue2: 1 plate

        const issue1 = await db.collection('users').doc(UID).collection('history').doc('issue1').get();
        expect(issue1.data().plateIds.sort()).toEqual(['ABC123', 'XYZ999']);

        const abcPlate = await db.collection('users').doc(UID).collection('plates').doc('ABC123').get();
        expect(abcPlate.data().incidentIds.sort()).toEqual(['issue1', 'issue2']);

        const xyzPlate = await db.collection('users').doc(UID).collection('plates').doc('XYZ999').get();
        expect(xyzPlate.data().incidentIds).toEqual(['issue1']);
    });

    it('skips history docs with no plate', async () => {
        await db.collection('users').doc(UID).collection('history').doc('no-plate').set({ address: '1 Main St' });
        const result = await backfillPlates(db, admin.firestore.FieldValue.arrayUnion, UID);
        expect(result.historyDocsTouched).toBe(0);
        expect(result.plateDocsTouched).toBe(0);
    });

    it('is idempotent -- a second run makes no further history-doc writes once plateIds is already correct', async () => {
        await db.collection('users').doc(UID).collection('history').doc('issue1').set({ plate: 'ABC123' });
        await backfillPlates(db, admin.firestore.FieldValue.arrayUnion, UID);
        const second = await backfillPlates(db, admin.firestore.FieldValue.arrayUnion, UID);
        expect(second.historyDocsTouched).toBe(0);
    });
});

describe('seedGeofences', () => {
    it('writes every geofence in GEOFENCES under its id', async () => {
        await seedGeofences(db, UID);
        const snapshot = await db.collection('users').doc(UID).collection('geofences').get();
        expect(snapshot.docs.map((d) => d.id).sort()).toEqual(GEOFENCES.map((g) => g.id).sort());

        const garBuilding = await db.collection('users').doc(UID).collection('geofences').doc('gar-building').get();
        expect(garBuilding.data().name).toBe(GEOFENCES.find((g) => g.id === 'gar-building').name);
    });

    it('is safe to re-run (merge, not overwrite-from-scratch)', async () => {
        await seedGeofences(db, UID);
        await db.collection('users').doc(UID).collection('geofences').doc('gar-building')
            .set({ userAddedField: 'kept' }, { merge: true });
        await seedGeofences(db, UID);
        const doc = await db.collection('users').doc(UID).collection('geofences').doc('gar-building').get();
        expect(doc.data().userAddedField).toBe('kept');
    });
});

describe('tagGeofenceOnIssues', () => {
    it('tags existing history entries with the given geofenceId', async () => {
        await db.collection('users').doc(UID).collection('history').doc('111').set({ address: '1 Main St' });
        await db.collection('users').doc(UID).collection('history').doc('222').set({ address: '2 Main St' });

        const result = await tagGeofenceOnIssues(db, UID, 'gar-building', ['111', '222']);
        expect(result).toEqual({ tagged: 2, total: 2 });

        const doc = await db.collection('users').doc(UID).collection('history').doc('111').get();
        expect(doc.data().geofenceId).toBe('gar-building');
    });

    it('skips issue ids with no history entry, without throwing', async () => {
        await db.collection('users').doc(UID).collection('history').doc('111').set({ address: '1 Main St' });
        const result = await tagGeofenceOnIssues(db, UID, 'gar-building', ['111', 'does-not-exist']);
        expect(result).toEqual({ tagged: 1, total: 2 });
    });
});

describe('importIssues', () => {
    it('writes one history doc per issue, keyed by issue id', async () => {
        const issues = [
            { id: 111, address: '1 Main St', created_at: '2024-01-01T00:00:00Z', status: 'Open' },
            { id: 222, address: '2 Main St', created_at: '2024-01-02T00:00:00Z', status: 'Closed' },
        ];
        const result = await importIssues(db, UID, issues);
        expect(result.written).toBe(2);

        const doc = await db.collection('users').doc(UID).collection('history').doc('111').get();
        expect(doc.data()).toMatchObject({ address: '1 Main St', status: 'Open' });
    });

    it('writes nothing for an empty issue list', async () => {
        const result = await importIssues(db, UID, []);
        expect(result.written).toBe(0);
    });
});
