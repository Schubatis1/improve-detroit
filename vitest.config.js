const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.js'],
        // These need the Firebase emulator (npm run test:rules) and are
        // excluded from the default `npm test` run.
        exclude: [
            'node_modules/**',
            'test/firestore.rules.test.js',
            'test/storage.rules.test.js',
            'test/scripts.integration.test.js',
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            // Only the code this suite is actually meant to unit-test --
            // index.html's inline app script and the Playwright-driven
            // parts of scripts/*.js are out of scope for line coverage
            // (see README's Tests section for why).
            include: ['lib/**/*.js', 'api/**/*.js', 'scripts/**/*.js'],
        },
    },
});
