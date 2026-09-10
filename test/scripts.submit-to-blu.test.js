const { parseArgs, detroitDateParts, randomSubmissionDelayMs } = require('../scripts/submit-to-blu.js');

describe('submit-to-blu parseArgs', () => {
    it('defaults email and limit', () => {
        expect(parseArgs([])).toEqual({ email: 'aschubatis@gmail.com', limit: 10 });
    });

    it('parses --dry-run and --headed as boolean flags', () => {
        const args = parseArgs(['--dry-run', '--headed']);
        expect(args.dryRun).toBe(true);
        expect(args.headed).toBe(true);
    });

    it('parses --email, --limit, --service-account with their values', () => {
        const args = parseArgs(['--email', 'foo@example.com', '--limit', '3', '--service-account', 'key.json']);
        expect(args.email).toBe('foo@example.com');
        expect(args.limit).toBe(3);
        expect(args.serviceAccount).toBe('key.json');
    });
});

describe('detroitDateParts', () => {
    it('converts a UTC instant to Detroit local date/time parts (winter, EST)', () => {
        // Jan 7 2026, 15:00 UTC = 10:00 AM EST in Detroit.
        const parts = detroitDateParts(new Date('2026-01-07T15:00:00Z'));
        expect(parts).toEqual({
            month: 'January',
            day: 7,
            year: '2026',
            hour12: '10',
            minute: '00',
            ampm: 'AM',
        });
    });

    it('converts correctly across the summer DST offset (EDT, UTC-4)', () => {
        // Jul 7 2026, 15:00 UTC = 11:00 AM EDT in Detroit.
        const parts = detroitDateParts(new Date('2026-07-07T15:00:00Z'));
        expect(parts).toEqual({
            month: 'July',
            day: 7,
            year: '2026',
            hour12: '11',
            minute: '00',
            ampm: 'AM',
        });
    });

    it('rolls over to the previous Detroit calendar day near UTC midnight', () => {
        // Jan 1 2026, 02:00 UTC = Dec 31 2025, 9:00 PM EST -- a naive
        // UTC read would report Jan 1, a whole day off.
        const parts = detroitDateParts(new Date('2026-01-01T02:00:00Z'));
        expect(parts.month).toBe('December');
        expect(parts.day).toBe(31);
        expect(parts.year).toBe('2025');
        expect(parts.hour12).toBe('09');
        expect(parts.ampm).toBe('PM');
    });

    it('pads the hour to two digits', () => {
        // 14:05 UTC = 9:05 AM EST.
        const parts = detroitDateParts(new Date('2026-01-07T14:05:00Z'));
        expect(parts.hour12).toBe('09');
        expect(parts.minute).toBe('05');
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
