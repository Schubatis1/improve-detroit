// Tests for firestore.rules -- the actual access-control boundary for this
// single-user, public-repo app (see firestore.rules' own header comments
// and README's key-rotation section). Requires the Firebase emulator; run
// via `npm run test:rules` (wraps this in `firebase emulators:exec`), not
// `npm test`.
const fs = require('fs');
const path = require('path');
const {
    initializeTestEnvironment,
    assertSucceeds,
    assertFails,
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'improve-detroit-rules-test';
const OWNER_UID = 'owner-uid';
const OTHER_UID = 'other-uid';
const OWNER_EMAIL = 'aschubatis@gmail.com';

let testEnv;

beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
        },
    });
});

afterAll(async () => {
    await testEnv.cleanup();
});

afterEach(async () => {
    await testEnv.clearFirestore();
});

function ownerAuth() {
    return testEnv.authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true }).firestore();
}
function ownerUnverifiedAuth() {
    return testEnv.authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: false }).firestore();
}
function otherUserAuth() {
    return testEnv.authenticatedContext(OTHER_UID, { email: 'someone-else@example.com', email_verified: true }).firestore();
}
function unauthed() {
    return testEnv.unauthenticatedContext().firestore();
}

// Seeds a doc bypassing security rules entirely (for arranging state the
// rules under test would themselves block writing).
async function seedAsAdmin(docPath, data) {
    await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().doc(docPath).set(data);
    });
}

// Every users/{uid}/{collection} subcollection in firestore.rules shares
// the exact same owner-only read/write rule -- history, plates,
// usdotNumbers, companies, geofences, parkingDeptLetters, settings. Table-
// test them all the same way instead of writing near-identical blocks 7
// times; errorLogs (create-only, no update/delete) and config (read-only)
// get their own dedicated describe blocks below since their rules differ.
const OWNER_ONLY_COLLECTIONS = [
    'history', 'plates', 'usdotNumbers', 'companies', 'geofences', 'parkingDeptLetters', 'settings',
];

for (const collection of OWNER_ONLY_COLLECTIONS) {
    describe(`users/{uid}/${collection}/{docId}`, () => {
        it('the owner (right uid, verified email) can read and write', async () => {
            const db = ownerAuth();
            const ref = db.doc(`users/${OWNER_UID}/${collection}/doc1`);
            await assertSucceeds(ref.set({ a: 1 }));
            await assertSucceeds(ref.get());
        });

        it('a different signed-in user cannot read or write another uid\'s docs', async () => {
            const db = otherUserAuth();
            const ref = db.doc(`users/${OWNER_UID}/${collection}/doc1`);
            await assertFails(ref.set({ a: 1 }));
            await assertFails(ref.get());
        });

        it('the owner uid with an unverified email is denied', async () => {
            const db = ownerUnverifiedAuth();
            const ref = db.doc(`users/${OWNER_UID}/${collection}/doc1`);
            await assertFails(ref.set({ a: 1 }));
            await assertFails(ref.get());
        });

        it('an unauthenticated request is denied', async () => {
            const db = unauthed();
            const ref = db.doc(`users/${OWNER_UID}/${collection}/doc1`);
            await assertFails(ref.set({ a: 1 }));
            await assertFails(ref.get());
        });

        it('a signed-in user with the right email but someone else\'s uid is denied (uid must match auth.uid)', async () => {
            // Simulates a token with the right email claim but requested
            // against a different uid path -- the rule requires BOTH.
            const db = testEnv.authenticatedContext(OTHER_UID, { email: OWNER_EMAIL, email_verified: true }).firestore();
            const ref = db.doc(`users/${OWNER_UID}/${collection}/doc1`);
            await assertFails(ref.set({ a: 1 }));
        });
    });
}

describe('users/{uid} (the user doc itself)', () => {
    it('the owner can read and write', async () => {
        const db = ownerAuth();
        await assertSucceeds(db.doc(`users/${OWNER_UID}`).set({ lastSeenVersion: '1.0.0' }));
    });

    it('another user cannot', async () => {
        const db = otherUserAuth();
        await assertFails(db.doc(`users/${OWNER_UID}`).set({ lastSeenVersion: '1.0.0' }));
    });
});

describe('users/{uid}/errorLogs/{logId} (append-only audit trail)', () => {
    it('the owner can create and read', async () => {
        const db = ownerAuth();
        const ref = db.doc(`users/${OWNER_UID}/errorLogs/log1`);
        await assertSucceeds(ref.set({ message: 'oops' }));
        await assertSucceeds(ref.get());
    });

    it('the owner cannot update an existing log entry', async () => {
        await seedAsAdmin(`users/${OWNER_UID}/errorLogs/log1`, { message: 'original' });

        const db = ownerAuth();
        await assertFails(db.doc(`users/${OWNER_UID}/errorLogs/log1`).set({ message: 'edited' }, { merge: true }));
    });

    it('the owner cannot delete a log entry', async () => {
        await seedAsAdmin(`users/${OWNER_UID}/errorLogs/log1`, { message: 'original' });

        const db = ownerAuth();
        await assertFails(db.doc(`users/${OWNER_UID}/errorLogs/log1`).delete());
    });

    it('another user cannot create a log entry under the owner\'s uid', async () => {
        const db = otherUserAuth();
        await assertFails(db.doc(`users/${OWNER_UID}/errorLogs/log1`).set({ message: 'hijack' }));
    });
});

describe('config/{document} (runtime secrets: geminiApiKey, mailStreamApiKey)', () => {
    it('the owner can read', async () => {
        await seedAsAdmin('config/secrets', { geminiApiKey: 'test-key' });

        const db = ownerAuth();
        await assertSucceeds(db.doc('config/secrets').get());
    });

    it('the owner cannot write -- config is read-only from the client even for the authorized user', async () => {
        const db = ownerAuth();
        await assertFails(db.doc('config/secrets').set({ geminiApiKey: 'stolen' }));
    });

    it('another signed-in user cannot read', async () => {
        await seedAsAdmin('config/secrets', { geminiApiKey: 'test-key' });

        const db = otherUserAuth();
        await assertFails(db.doc('config/secrets').get());
    });

    it('an unauthenticated request cannot read', async () => {
        await seedAsAdmin('config/secrets', { geminiApiKey: 'test-key' });

        const db = unauthed();
        await assertFails(db.doc('config/secrets').get());
    });
});
