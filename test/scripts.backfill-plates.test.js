const { parseArgs } = require('../scripts/backfill-plates.js');

describe('backfill-plates parseArgs', () => {
    it('defaults email', () => {
        expect(parseArgs([])).toEqual({ email: 'aschubatis@gmail.com' });
    });

    it('parses --key value pairs generically', () => {
        const args = parseArgs(['--service-account', 'key.json', '--email', 'foo@example.com']);
        expect(args['service-account']).toBe('key.json');
        expect(args.email).toBe('foo@example.com');
    });
});
