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
        if (filters.bikeBureauStatus && (entry.bikeBureauStatus || '') !== filters.bikeBureauStatus) return false;
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

    // Merges a fresh Firestore history snapshot with the current cache,
    // preserving any entry still marked _localOnly (its write failed after
    // retrying -- see index.html's addToHistory) that the snapshot doesn't
    // have yet. Without this, onSnapshot firing for any OTHER change to the
    // collection -- another report in the same batch succeeding, most
    // commonly -- would silently wipe a failed-but-locally-cached entry out
    // of history entirely, with no trace beyond the debug console.
    function mergeHistorySnapshot(currentCache, synced) {
        const stillUnsynced = currentCache.filter((e) =>
            e._localOnly && !synced.some((s) => s.issueId === e.issueId)
        );
        return [...stillUnsynced, ...synced].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    }

    const api = { isBluLocked, parkingDeptStatusCategory, applyHistoryFilters, mergeHistorySnapshot };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
