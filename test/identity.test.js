const {
    normalizePlate,
    plateDocId,
    normalizeCompanyName,
    companyDocId,
    normalizeUsdot,
    usdotDocId,
    dedupeByNormalizedId,
    parsePlateIds,
    parseCompanyIds,
    parseUsdotIds,
} = require('../lib/identity.js');

describe('normalizePlate', () => {
    it('uppercases and strips whitespace', () => {
        expect(normalizePlate(' abc 123 ')).toBe('ABC123');
    });

    it('handles null/undefined/empty', () => {
        expect(normalizePlate(null)).toBe('');
        expect(normalizePlate(undefined)).toBe('');
        expect(normalizePlate('')).toBe('');
    });

    it('two differently-formatted inputs normalize the same', () => {
        expect(normalizePlate('abc 123')).toBe(normalizePlate('ABC123'));
        expect(normalizePlate('  abc123  ')).toBe(normalizePlate('ABC123'));
    });
});

describe('plateDocId', () => {
    it('normalizes and replaces "/" with "-" (Firestore forbids "/" in a segment)', () => {
        expect(plateDocId('abc/123')).toBe('ABC-123');
    });

    it('is stable for equivalent plates', () => {
        expect(plateDocId('abc 123')).toBe(plateDocId('ABC123'));
    });
});

describe('normalizeCompanyName', () => {
    it('uppercases, collapses non-alnum runs to a single space, and trims', () => {
        expect(normalizeCompanyName('  acme, inc.  ')).toBe('ACME INC');
    });

    it('does NOT strip common suffixes -- precision over recall', () => {
        expect(normalizeCompanyName('Acme LLC')).not.toBe(normalizeCompanyName('Acme'));
    });

    it('handles null/undefined/empty', () => {
        expect(normalizeCompanyName(null)).toBe('');
        expect(normalizeCompanyName(undefined)).toBe('');
    });
});

describe('companyDocId', () => {
    it('joins normalized words with a single hyphen', () => {
        expect(companyDocId('Acme, Inc.')).toBe('ACME-INC');
    });
});

describe('normalizeUsdot / usdotDocId', () => {
    it('strips everything but digits', () => {
        expect(normalizeUsdot('USDOT 123456')).toBe('123456');
        expect(normalizeUsdot('US DOT#123456')).toBe('123456');
    });

    it('usdotDocId mirrors normalizeUsdot', () => {
        expect(usdotDocId('USDOT 123456')).toBe('123456');
    });

    it('handles null/undefined/empty', () => {
        expect(normalizeUsdot(null)).toBe('');
        expect(usdotDocId(undefined)).toBe('');
    });
});

describe('dedupeByNormalizedId', () => {
    it('drops blanks and dedupes by the normalized id, keeping first raw value', () => {
        const result = dedupeByNormalizedId([' abc123 ', '', 'ABC 123', 'xyz999'], normalizePlate);
        expect(result).toEqual(['abc123', 'xyz999']);
    });

    it('drops values that normalize to empty', () => {
        expect(dedupeByNormalizedId(['   ', null], normalizePlate)).toEqual([]);
    });
});

describe('parsePlateIds', () => {
    it('splits a comma-joined field into deduped doc ids', () => {
        expect(parsePlateIds('ABC123, abc 123, XYZ999')).toEqual(['ABC123', 'XYZ999']);
    });

    it('handles empty input', () => {
        expect(parsePlateIds('')).toEqual([]);
        expect(parsePlateIds(undefined)).toEqual([]);
    });
});

describe('parseCompanyIds', () => {
    it('splits on commas (each segment is one company name) and dedupes by companyDocId', () => {
        expect(parseCompanyIds('Acme Inc, acme inc, Widgets Co')).toEqual(['ACME-INC', 'WIDGETS-CO']);
    });

    it('does not split a single company name on internal spaces', () => {
        // A comma-separated segment is treated as one company name, not
        // further tokenized -- "Acme Inc" stays one id, distinct from "Acme".
        expect(parseCompanyIds('Acme Inc, Acme')).toEqual(['ACME-INC', 'ACME']);
    });
});

describe('parseUsdotIds', () => {
    it('splits and dedupes by usdotDocId', () => {
        expect(parseUsdotIds('USDOT 123456, 123456, 789012')).toEqual(['123456', '789012']);
    });
});
