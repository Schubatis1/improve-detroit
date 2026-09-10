const { defineConfig } = require('vitest/config');

// Separate config for the Firestore/Storage security rules tests, which
// need a running Firebase emulator (see package.json's "test:rules" script,
// which wraps this in `firebase emulators:exec`) -- kept out of the default
// `npm test` config since those tests hang/fail without the emulator.
module.exports = defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/firestore.rules.test.js', 'test/storage.rules.test.js'],
        // Rules tests spin up their own RulesTestEnvironment per file and
        // can be slow under emulator startup; keep them from racing.
        fileParallelism: false,
    },
});
