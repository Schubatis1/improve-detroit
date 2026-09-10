// Pure helpers for classifying Submission History entries, shared by
// index.html and the test suite.
(function (globalObj) {
    'use strict';

    function isBluLocked(entry) {
        return !!entry.bluStatus && entry.bluStatus !== 'pending';
    }

    // Buckets parkingDeptFlag (+ whether it's ever been checked) into
    // the 4 categories the Parking Dept Status filter offers:
    // - 'notDetermined': never checked (parkingDeptLastCheckedAt unset)
    //   -- Search hasn't reached it yet, and it's never been manually
    //   checked via "Check Issue" either.
    // - 'notRequested': checked and no referral found (or manually
    //   dismissed as a false match) -- determined a notification isn't
    //   needed.
    // - 'awaiting': matched (flagged) or a letter's been generated
    //   (lettered), but not yet marked notified.
    // - 'notified': done.
    function parkingDeptStatusCategory(entry) {
        if (entry.parkingDeptFlag === 'notified') return 'notified';
        if (entry.parkingDeptFlag === 'flagged' || entry.parkingDeptFlag === 'lettered') return 'awaiting';
        if (entry.parkingDeptFlag === 'dismissed') return 'notRequested';
        if (entry.parkingDeptLastCheckedAt) return 'notRequested';
        return 'notDetermined';
    }

    // Predicate for the Submission History filters -- every active filter
    // must match (AND, not OR). Date range is inclusive and compares by
    // calendar day (not time-of-day) in the browser's local timezone,
    // matching what the date inputs themselves show. `filters` was
    // originally read from the app's global `historyFilters`; taking it as
    // a parameter makes this testable in isolation.
    function applyHistoryFilters(entry, filters) {
        if (filters.parkingDept && parkingDeptStatusCategory(entry) !== filters.parkingDept) return false;
        if (filters.bluStatus && (entry.bluStatus || '') !== filters.bluStatus) return false;
        if (filters.status && (entry.status || '') !== filters.status) return false;
        if (filters.geofenceId) {
            if (filters.geofenceId === '__none__' ? !!entry.geofenceId : entry.geofenceId !== filters.geofenceId) return false;
        }
        if (filters.dateFrom || filters.dateTo) {
            const submitted = new Date(entry.submittedAt);
            if (filters.dateFrom && submitted < new Date(filters.dateFrom + 'T00:00:00')) return false;
            if (filters.dateTo && submitted > new Date(filters.dateTo + 'T23:59:59')) return false;
        }
        return true;
    }

    const api = { isBluLocked, parkingDeptStatusCategory, applyHistoryFilters };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
