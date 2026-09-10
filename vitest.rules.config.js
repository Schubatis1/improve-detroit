const { defineConfig } = require('vitest/config');

// Separate config for tests that need a running Firebase emulator (see
// package.json's "test:rules" script, which wraps this in
// `firebase emulators:exec`) -- kept out of the default `npm test` config
// since these hang/fail without the emulator: the Firestore/Storage
// security rules tests, and the scripts/*.js Firestore-writing integration
// tests (which run against the same emulator via the Admin SDK, which
// always bypasses rules).
module.exports = defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: [
            'test/firestore.rules.test.js',
            'test/storage.rules.test.js',
            'test/scripts.integration.test.js',
        ],
        // Rules tests spin up their own RulesTestEnvironment per file and
        // can be slow under emulator startup; keep them from racing.
        fileParallelism: false,
    },
});
