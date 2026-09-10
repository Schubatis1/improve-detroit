const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.js'],
        // Rules tests need the Firebase emulator (npm run test:rules) and
        // are excluded from the default `npm test` run.
        exclude: ['node_modules/**', 'test/firestore.rules.test.js', 'test/storage.rules.test.js'],
    },
});
