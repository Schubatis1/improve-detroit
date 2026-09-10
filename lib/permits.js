// Pure helpers for the ArcGIS permit-lookup feature (Right-of-Way / BSEED
// building permits), shared by index.html and the test suite.
(function (globalObj) {
    'use strict';

    function permitSortDate(feature, dateFields) {
        for (const field of dateFields) {
            const value = feature.attributes[field];
            if (value) return value;
        }
        return '';
    }

    function sortPermitsNewestFirst(features, dateFields) {
        return [...features].sort((a, b) => permitSortDate(b, dateFields).localeCompare(permitSortDate(a, dateFields)));
    }

    // The RoW Points layer has one row per street-segment the permit
    // touches, not one row per permit -- ENG-23-557 alone comes back as
    // 3 rows (Henry St, Cass Ave, the alley), all with identical dates/
    // description. Collapsing to one card per application_id avoids
    // showing the same permit 2-3 times in a row.
    function dedupeByField(features, field) {
        const seen = new Set();
        return features.filter((feature) => {
            const key = feature.attributes[field];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    // "Active" only applies to Right-of-Way permits -- they're the only
    // dataset here with a defined start/end closure window; BSEED
    // building permits have no such window (or any status field) in
    // this feed, so the active-only filter never touches them.
    //
    // Accepts an optional `today` (YYYY-MM-DD) override for tests; the
    // real call site always uses today's date.
    function isRowPermitActiveToday(feature, today = new Date().toISOString().slice(0, 10)) {
        const { start_date, end_date } = feature.attributes;
        if (!start_date || !end_date) return false;
        return start_date <= today && today <= end_date;
    }

    const api = {
        permitSortDate,
        sortPermitsNewestFirst,
        dedupeByField,
        isRowPermitActiveToday,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
