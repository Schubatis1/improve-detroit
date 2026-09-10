// Pure identity-normalization helpers (plate/company/USDOT) shared by
// index.html, scripts/backfill-plates.js, and the test suite. These decide
// whether two reports get linked as the same repeat offender -- see
// index.html's platesCollection/usdotNumbersCollection/companiesCollection
// comments for how the resulting doc ids are used.
(function (globalObj) {
    'use strict';

    // Normalizes a detected plate for matching against config.plateRules.
    function normalizePlate(plate) {
        return String(plate || '').toUpperCase().replace(/\s+/g, '');
    }

    // Sanitizes a normalized plate into a safe Firestore document id.
    function plateDocId(plate) {
        return normalizePlate(plate).replace(/\//g, '-');
    }

    // Normalizes a detected company/business name for matching -- free
    // text, so this only collapses trivial formatting differences
    // (case, punctuation, extra whitespace). Deliberately does NOT
    // strip common suffixes (LLC/INC/CORP/CO) -- that would catch more
    // real matches but also risks merging two different companies that
    // happen to share a base name, and USDOT (not company name) is the
    // primary join key here (see usdotNumbersCollection), so this
    // fallback favors precision over recall.
    function normalizeCompanyName(name) {
        return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    }

    // Sanitizes a normalized company name into a safe Firestore document
    // id, mirroring plateDocId above.
    function companyDocId(name) {
        return normalizeCompanyName(name).replace(/\s+/g, '-');
    }

    // USDOT numbers are purely numeric placard ids -- strip everything
    // else so formatting variants ("USDOT 123456", "US DOT#123456")
    // all resolve to the same doc id.
    function normalizeUsdot(usdot) {
        return String(usdot || '').replace(/\D+/g, '');
    }

    // Sanitizes a normalized USDOT number into a safe Firestore document
    // id. Already digits-only after normalizeUsdot, so this is a no-op
    // today, but mirrors plateDocId/companyDocId for consistency.
    function usdotDocId(usdot) {
        return normalizeUsdot(usdot);
    }

    // Splits a comma-joined field (possibly merged by combineReports)
    // into individual normalized ids, deduped -- shared by
    // parseCompanyIds/parseUsdotIds below.
    function dedupeByNormalizedId(rawValues, idFn) {
        const seen = new Set();
        const result = [];
        for (const raw of rawValues) {
            const trimmed = String(raw || '').trim();
            if (!trimmed) continue;
            const id = idFn(trimmed);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            result.push(trimmed);
        }
        return result;
    }

    // Splits a submission's raw plate field (a single plate, or several
    // comma-joined together by combineReports when merging multiple
    // ready reports into one) into individual plate doc ids, deduped.
    // Used at write time (addToHistory) to populate both plateIds and
    // the plates index.
    function parsePlateIds(rawPlate) {
        return [...new Set(String(rawPlate || '').split(',').map(plateDocId).filter(Boolean))];
    }

    // Splits a submission's raw company field into individual company
    // doc ids, deduped. Mirrors parsePlateIds.
    function parseCompanyIds(rawCompany) {
        return [...new Set(String(rawCompany || '').split(',').map(companyDocId).filter(Boolean))];
    }

    // Splits a submission's raw USDOT field into individual USDOT doc
    // ids, deduped. Mirrors parsePlateIds.
    function parseUsdotIds(rawUsdot) {
        return [...new Set(String(rawUsdot || '').split(',').map(usdotDocId).filter(Boolean))];
    }

    const api = {
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
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
