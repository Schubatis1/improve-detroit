const { parseArgs, randomSubmissionDelayMs } = require('../scripts/submit-to-bikebureau.js');

describe('submit-to-bikebureau parseArgs', () => {
    it('defaults email and limit', () => {
        expect(parseArgs([])).toEqual({ email: 'aschubatis@gmail.com', limit: 10 });
    });

    it('parses --dry-run and --headed as boolean flags', () => {
        const args = parseArgs(['--dry-run', '--headed']);
        expect(args.dryRun).toBe(true);
        expect(args.headed).toBe(true);
    });

    it('parses --email, --limit, --service-account, --storage-state with their values', () => {
        const args = parseArgs(['--email', 'foo@example.com', '--limit', '3', '--service-account', 'key.json', '--storage-state', 'session.json']);
        expect(args.email).toBe('foo@example.com');
        expect(args.limit).toBe(3);
        expect(args.serviceAccount).toBe('key.json');
        expect(args.storageState).toBe('session.json');
    });
});

describe('randomSubmissionDelayMs', () => {
    it('always falls within [30s, 121s)', () => {
        for (let i = 0; i < 200; i++) {
            const ms = randomSubmissionDelayMs();
            expect(ms).toBeGreaterThanOrEqual(30000);
            expect(ms).toBeLessThan(121000);
        }
    });
});
