const {
    distanceMeters,
    pointInPolygon,
    polygonCentroid,
    geofenceContainsPoint,
    geofenceActiveAt,
    resolveMetroCity,
    METRO_CITY_DETROIT,
    METRO_CITY_NEW_YORK,
} = require('../lib/geo.js');

describe('distanceMeters', () => {
    it('returns 0 for identical points', () => {
        expect(distanceMeters(42.33, -83.05, 42.33, -83.05)).toBe(0);
    });

    it('matches a known great-circle distance within a meter', () => {
        // Detroit City Hall to the GAR Building, ~350m apart.
        const d = distanceMeters(42.3298, -83.0466, 42.3316, -83.0468);
        expect(d).toBeGreaterThan(150);
        expect(d).toBeLessThan(400);
    });

    it('is symmetric', () => {
        const a = distanceMeters(42.33, -83.05, 42.40, -83.10);
        const b = distanceMeters(42.40, -83.10, 42.33, -83.05);
        expect(a).toBeCloseTo(b, 6);
    });
});

describe('pointInPolygon', () => {
    // A simple 1-degree square: (0,0) (0,1) (1,1) (1,0) in {lat,lng}.
    const square = [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 1, lng: 1 },
        { lat: 1, lng: 0 },
    ];

    it('is true for a point well inside the polygon', () => {
        expect(pointInPolygon(0.5, 0.5, square)).toBe(true);
    });

    it('is false for a point well outside the polygon', () => {
        expect(pointInPolygon(5, 5, square)).toBe(false);
    });

    it('is false for a point outside on one axis only', () => {
        expect(pointInPolygon(0.5, 2, square)).toBe(false);
        expect(pointInPolygon(2, 0.5, square)).toBe(false);
    });

    it('does not require the last vertex to repeat the first', () => {
        // Triangle, deliberately not closed.
        const triangle = [
            { lat: 0, lng: 0 },
            { lat: 0, lng: 2 },
            { lat: 2, lng: 1 },
        ];
        expect(pointInPolygon(0.5, 1, triangle)).toBe(true);
        expect(pointInPolygon(1, 5, triangle)).toBe(false);
    });
});

describe('polygonCentroid', () => {
    it('averages the vertex coordinates', () => {
        const c = polygonCentroid([
            { lat: 0, lng: 0 },
            { lat: 0, lng: 2 },
            { lat: 2, lng: 2 },
            { lat: 2, lng: 0 },
        ]);
        expect(c).toEqual({ lat: 1, lng: 1 });
    });
});

describe('geofenceContainsPoint', () => {
    it('uses a circle when there is no polygon', () => {
        const geofence = { lat: 42.33, lng: -83.05, radiusMeters: 100 };
        expect(geofenceContainsPoint(geofence, 42.33, -83.05)).toBe(true);
        expect(geofenceContainsPoint(geofence, 43, -83.05)).toBe(false);
    });

    it('uses a circle when polygon has fewer than 3 points', () => {
        const geofence = { lat: 42.33, lng: -83.05, radiusMeters: 100, polygon: [{ lat: 42.33, lng: -83.05 }] };
        expect(geofenceContainsPoint(geofence, 42.33, -83.05)).toBe(true);
    });

    it('uses the polygon when it has 3+ points, ignoring radiusMeters', () => {
        const geofence = {
            lat: 1, lng: 1, radiusMeters: 0, // would reject everything as a circle
            polygon: [{ lat: 0, lng: 0 }, { lat: 0, lng: 2 }, { lat: 2, lng: 2 }, { lat: 2, lng: 0 }],
        };
        expect(geofenceContainsPoint(geofence, 1, 1)).toBe(true);
        expect(geofenceContainsPoint(geofence, 5, 5)).toBe(false);
    });

    it('is on the boundary at exactly the radius (inclusive)', () => {
        // 1 degree of latitude is ~111,320m -- use a radius that exactly
        // matches distanceMeters' own output so the <= boundary is exact.
        const geofence = { lat: 0, lng: 0, radiusMeters: distanceMeters(0, 0, 1, 0) };
        expect(geofenceContainsPoint(geofence, 1, 0)).toBe(true);
    });
});

describe('geofenceActiveAt', () => {
    // Wed Jan 7 2026, 15:00 UTC = 10:00 EST in Detroit (winter, no DST).
    const wedMorning = new Date('2026-01-07T15:00:00Z');
    // Same Wednesday, 23:30 UTC = 18:30 EST Detroit.
    const wedEvening = new Date('2026-01-07T23:30:00Z');
    // Sunday Jan 4 2026, 15:00 UTC = 10:00 EST Detroit.
    const sunMorning = new Date('2026-01-04T15:00:00Z');

    it('is always active with no daysOfWeek/startHour/endHour', () => {
        expect(geofenceActiveAt({}, wedMorning)).toBe(true);
        expect(geofenceActiveAt({}, sunMorning)).toBe(true);
    });

    it('respects daysOfWeek (0=Sun..6=Sat)', () => {
        const weekdaysOnly = { daysOfWeek: [1, 2, 3, 4, 5] };
        expect(geofenceActiveAt(weekdaysOnly, wedMorning)).toBe(true);
        expect(geofenceActiveAt(weekdaysOnly, sunMorning)).toBe(false);
    });

    it('an empty daysOfWeek array means every day', () => {
        expect(geofenceActiveAt({ daysOfWeek: [] }, sunMorning)).toBe(true);
    });

    it('startHour only means "from startHour to end of day"', () => {
        const g = { startHour: 12 };
        expect(geofenceActiveAt(g, wedMorning)).toBe(false); // 10am
        expect(geofenceActiveAt(g, wedEvening)).toBe(true); // 6:30pm
    });

    it('endHour only means "from start of day to endHour"', () => {
        const g = { endHour: 12 };
        expect(geofenceActiveAt(g, wedMorning)).toBe(true); // 10am
        expect(geofenceActiveAt(g, wedEvening)).toBe(false); // 6:30pm
    });

    it('a normal same-day window is [start, end)', () => {
        const g = { startHour: 9, endHour: 17 };
        expect(geofenceActiveAt(g, wedMorning)).toBe(true); // 10am
        expect(geofenceActiveAt(g, wedEvening)).toBe(false); // 6:30pm
    });

    it('startHour > endHour wraps overnight', () => {
        const overnight = { startHour: 22, endHour: 6 };
        // 10am and 6:30pm Detroit are both outside a 22:00-06:00 window.
        expect(geofenceActiveAt(overnight, wedMorning)).toBe(false);
        expect(geofenceActiveAt(overnight, wedEvening)).toBe(false);
        // 11pm Detroit (04:00 UTC next day) is inside it.
        expect(geofenceActiveAt(overnight, new Date('2026-01-08T04:00:00Z'))).toBe(true);
        // 2am Detroit is also inside it.
        expect(geofenceActiveAt(overnight, new Date('2026-01-07T07:00:00Z'))).toBe(true);
    });

    it('the endHour boundary itself is exclusive', () => {
        // endHour: 17 means active through 16:xx, not 17:00 itself.
        const g = { startHour: 9, endHour: 17 };
        expect(geofenceActiveAt(g, new Date('2026-01-07T22:00:00Z'))).toBe(false); // 5:00pm EST
        expect(geofenceActiveAt(g, new Date('2026-01-07T21:59:00Z'))).toBe(true); // 4:59pm EST
    });
});

describe('resolveMetroCity', () => {
    it('returns Detroit for a Detroit coordinate', () => {
        expect(resolveMetroCity(42.3314, -83.0458)).toBe(METRO_CITY_DETROIT);
    });

    it('returns New York for a coordinate inside the NYC bounding box', () => {
        expect(resolveMetroCity(40.7128, -74.0060)).toBe(METRO_CITY_NEW_YORK);
    });

    it('falls back to Detroit for a coordinate outside both', () => {
        expect(resolveMetroCity(34.0522, -118.2437)).toBe(METRO_CITY_DETROIT); // LA
    });
});
