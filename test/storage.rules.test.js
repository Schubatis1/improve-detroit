// Tests for storage.rules -- gates access to uploaded report photos at
// history/{uid}/{fileName}. Requires the Firebase emulator; run via
// `npm run test:rules`, not `npm test`.
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'improve-detroit-storage-rules-test';
const OWNER_UID = 'owner-uid';
const OTHER_UID = 'other-uid';
const OWNER_EMAIL = 'aschubatis@gmail.com';

// A 1x1 transparent PNG, small enough to inline.
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

let testEnv;

beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        storage: {
            rules: fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8'),
        },
    });
});

afterAll(async () => {
    await testEnv.cleanup();
});

afterEach(async () => {
    await testEnv.clearStorage();
});

function ownerStorage() {
    return testEnv.authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true }).storage();
}
function ownerUnverifiedStorage() {
    return testEnv.authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: false }).storage();
}
function otherUserStorage() {
    return testEnv.authenticatedContext(OTHER_UID, { email: 'someone-else@example.com', email_verified: true }).storage();
}
function unauthedStorage() {
    return testEnv.unauthenticatedContext().storage();
}

describe('history/{uid}/{fileName}', () => {
    it('the owner can upload and read their own photo', async () => {
        const ref = ownerStorage().ref(`history/${OWNER_UID}/photo1.jpg`);
        await assertSucceeds(ref.put(TINY_PNG, { contentType: 'image/png' }));
        await assertSucceeds(ref.getDownloadURL());
    });

    it('another signed-in user cannot read or write the owner\'s photos', async () => {
        const ref = otherUserStorage().ref(`history/${OWNER_UID}/photo1.jpg`);
        await assertFails(ref.put(TINY_PNG, { contentType: 'image/png' }));
        await assertFails(ref.getDownloadURL());
    });

    it('the owner uid with an unverified email is denied', async () => {
        const ref = ownerUnverifiedStorage().ref(`history/${OWNER_UID}/photo1.jpg`);
        await assertFails(ref.put(TINY_PNG, { contentType: 'image/png' }));
    });

    it('an unauthenticated request is denied', async () => {
        const ref = unauthedStorage().ref(`history/${OWNER_UID}/photo1.jpg`);
        await assertFails(ref.put(TINY_PNG, { contentType: 'image/png' }));
        await assertFails(ref.getDownloadURL());
    });
});
