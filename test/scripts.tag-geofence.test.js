const { parseArgs } = require('../scripts/tag-geofence.js');

describe('tag-geofence parseArgs', () => {
    it('defaults email', () => {
        expect(parseArgs([])).toEqual({ email: 'aschubatis@gmail.com' });
    });

    it('parses --geofence and --issue-ids', () => {
        const args = parseArgs(['--geofence', 'gar-building', '--issue-ids', '1,2,3']);
        expect(args.geofence).toBe('gar-building');
        expect(args['issue-ids']).toBe('1,2,3');
    });
});
