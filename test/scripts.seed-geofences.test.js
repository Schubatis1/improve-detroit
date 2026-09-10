const { parseArgs, GEOFENCES } = require('../scripts/seed-geofences.js');

describe('seed-geofences parseArgs', () => {
    it('defaults email', () => {
        expect(parseArgs([])).toEqual({ email: 'aschubatis@gmail.com' });
    });
});

describe('GEOFENCES', () => {
    it('every geofence has a unique id', () => {
        const ids = GEOFENCES.map((g) => g.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every geofence has either a radiusMeters circle or a 3+ point polygon', () => {
        for (const g of GEOFENCES) {
            const hasCircle = typeof g.radiusMeters === 'number';
            const hasPolygon = Array.isArray(g.polygon) && g.polygon.length >= 3;
            expect(hasCircle || hasPolygon).toBe(true);
        }
    });
});
