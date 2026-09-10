const {
    permitSortDate,
    sortPermitsNewestFirst,
    dedupeByField,
    isRowPermitActiveToday,
} = require('../lib/permits.js');

function feature(attributes) {
    return { attributes };
}

describe('permitSortDate', () => {
    it('returns the first non-empty field in order', () => {
        const f = feature({ a: '', b: '2024-01-01', c: '2024-06-01' });
        expect(permitSortDate(f, ['a', 'b', 'c'])).toBe('2024-01-01');
    });

    it('returns empty string when no field has a value', () => {
        expect(permitSortDate(feature({}), ['a', 'b'])).toBe('');
    });
});

describe('sortPermitsNewestFirst', () => {
    it('sorts descending by the resolved date', () => {
        const features = [
            feature({ d: '2024-01-01' }),
            feature({ d: '2024-06-01' }),
            feature({ d: '2024-03-01' }),
        ];
        const sorted = sortPermitsNewestFirst(features, ['d']);
        expect(sorted.map((f) => f.attributes.d)).toEqual(['2024-06-01', '2024-03-01', '2024-01-01']);
    });

    it('does not mutate the input array', () => {
        const features = [feature({ d: '2024-01-01' }), feature({ d: '2024-06-01' })];
        const original = [...features];
        sortPermitsNewestFirst(features, ['d']);
        expect(features).toEqual(original);
    });
});

describe('dedupeByField', () => {
    it('keeps only the first row per key', () => {
        const features = [
            feature({ application_id: 'A', segment: 1 }),
            feature({ application_id: 'A', segment: 2 }),
            feature({ application_id: 'B', segment: 1 }),
        ];
        const deduped = dedupeByField(features, 'application_id');
        expect(deduped).toHaveLength(2);
        expect(deduped.map((f) => f.attributes.segment)).toEqual([1, 1]);
    });
});

describe('isRowPermitActiveToday', () => {
    it('is false when start_date or end_date is missing', () => {
        expect(isRowPermitActiveToday(feature({ start_date: '2024-01-01' }))).toBe(false);
        expect(isRowPermitActiveToday(feature({ end_date: '2024-01-01' }))).toBe(false);
    });

    it('is true when today falls within [start_date, end_date]', () => {
        const f = feature({ start_date: '2024-01-01', end_date: '2024-12-31' });
        expect(isRowPermitActiveToday(f, '2024-06-15')).toBe(true);
    });

    it('is inclusive of the start and end dates', () => {
        const f = feature({ start_date: '2024-01-01', end_date: '2024-12-31' });
        expect(isRowPermitActiveToday(f, '2024-01-01')).toBe(true);
        expect(isRowPermitActiveToday(f, '2024-12-31')).toBe(true);
    });

    it('is false before start_date or after end_date', () => {
        const f = feature({ start_date: '2024-06-01', end_date: '2024-06-30' });
        expect(isRowPermitActiveToday(f, '2024-05-31')).toBe(false);
        expect(isRowPermitActiveToday(f, '2024-07-01')).toBe(false);
    });
});
