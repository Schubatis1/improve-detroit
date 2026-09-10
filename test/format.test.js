const {
    escapeHtml,
    formatPriorComplaints,
    pickRandomDescription,
    parsePolygonPointsText,
    polygonPointsToText,
} = require('../lib/format.js');

describe('escapeHtml', () => {
    it('escapes & < > but leaves quotes alone (matches the DOM textContent/innerHTML round-trip it replaced)', () => {
        expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
        expect(escapeHtml(`it's "quoted"`)).toBe(`it's "quoted"`);
    });

    it('escapes & before < / > so entities are not double-escaped', () => {
        expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    });

    it('coerces non-strings', () => {
        expect(escapeHtml(123)).toBe('123');
        expect(escapeHtml(null)).toBe('null');
    });
});

describe('formatPriorComplaints', () => {
    it('handles no ids', () => {
        expect(formatPriorComplaints([])).toBe('incidents at this location');
        expect(formatPriorComplaints(undefined)).toBe('incidents at this location');
    });

    it('handles a single id', () => {
        expect(formatPriorComplaints([123])).toBe('issue #123');
    });

    it('handles two ids (no oxford comma)', () => {
        expect(formatPriorComplaints([123, 456])).toBe('issues #123 and #456');
    });

    it('handles three or more ids (oxford comma)', () => {
        expect(formatPriorComplaints([123, 456, 789])).toBe('issues #123, #456, and #789');
    });
});

describe('pickRandomDescription', () => {
    it('fills in the address placeholder', () => {
        const workflow = { descriptions: ['Vehicle near {{ADDRESS}}.'] };
        expect(pickRandomDescription(workflow, '123 Main St')).toBe('Vehicle near 123 Main St.');
    });

    it('fills in the prior-complaints placeholder', () => {
        const workflow = { descriptions: ['Repeat at {{ADDRESS}} -- see {{PRIOR_COMPLAINTS}}.'], priorComplaintIds: [1, 2] };
        expect(pickRandomDescription(workflow, '1 Main St')).toBe('Repeat at 1 Main St -- see issues #1 and #2.');
    });

    it('only ever returns a template from the pool', () => {
        const workflow = { descriptions: ['A {{ADDRESS}}', 'B {{ADDRESS}}', 'C {{ADDRESS}}'] };
        for (let i = 0; i < 20; i++) {
            const result = pickRandomDescription(workflow, 'X');
            expect(['A X', 'B X', 'C X']).toContain(result);
        }
    });
});

describe('parsePolygonPointsText', () => {
    it('parses "lat, lng" lines into points', () => {
        expect(parsePolygonPointsText('42.33, -83.05\n42.34, -83.06')).toEqual([
            { lat: 42.33, lng: -83.05 },
            { lat: 42.34, lng: -83.06 },
        ]);
    });

    it('skips blank lines', () => {
        expect(parsePolygonPointsText('42.33, -83.05\n\n42.34, -83.06\n')).toHaveLength(2);
    });

    it('drops lines that do not parse to two finite numbers', () => {
        expect(parsePolygonPointsText('not a point\n42.33, -83.05\n42.33,')).toEqual([
            { lat: 42.33, lng: -83.05 },
        ]);
    });
});

describe('polygonPointsToText', () => {
    it('formats points with 6 decimal places, one per line', () => {
        expect(polygonPointsToText([{ lat: 42.33, lng: -83.05 }])).toBe('42.330000, -83.050000');
    });

    it('round-trips through parsePolygonPointsText', () => {
        const points = [{ lat: 42.331234, lng: -83.051234 }, { lat: 1, lng: -1 }];
        expect(parsePolygonPointsText(polygonPointsToText(points))).toEqual(points);
    });
});
