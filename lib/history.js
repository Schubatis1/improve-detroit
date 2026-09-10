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

    const api = { isBluLocked, parkingDeptStatusCategory };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
