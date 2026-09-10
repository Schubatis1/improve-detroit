// Pure geofence/plate-rule workflow resolution, shared by index.html and
// the test suite. Originally read the app's global `geofencesCache`/CONFIG
// directly; refactored to take them as parameters so this logic (which
// decides which category/message a report gets filed under) is testable
// without the rest of the app's state.
(function (globalObj) {
    'use strict';

    const deps = (typeof module !== 'undefined' && module.exports)
        ? Object.assign({}, require('./geo.js'), require('./identity.js'))
        : globalObj;
    const { geofenceContainsPoint, geofenceActiveAt, normalizePlate } = deps;

    // Finds the first configured geofence (if any) containing (lat, lng)
    // that is also currently active (see geofenceActiveAt), and merges its
    // fields over `defaultWorkflow` -- fields the geofence doesn't set fall
    // back to the default. `when` defaults to now; pass the photo's own
    // capture time for time-bound geofences to gate on when the
    // obstruction happened, not when it's processed.
    function resolveWorkflow(defaultWorkflow, geofences, lat, lng, when) {
        const now = when || new Date();
        const geofence = geofences.find((g) =>
            geofenceContainsPoint(g, lat, lng)
            && geofenceActiveAt(g, now)
        );
        const workflow = { ...defaultWorkflow };
        if (geofence) {
            if (geofence.message) workflow.descriptions = [geofence.message];
            if (geofence.bluCategory) workflow.bluCategory = geofence.bluCategory;
            if (geofence.improveDetroitCategory) workflow.natureValue = geofence.improveDetroitCategory;
        }
        return { workflow, geofence };
    }

    // Finds the first plate rule (if any) matching a detected plate.
    function findPlateRule(plate, plateRules) {
        const normalized = normalizePlate(plate);
        if (!normalized) return null;
        return plateRules.find((rule) =>
            rule.plates.some((p) => normalizePlate(p) === normalized)
        ) || null;
    }

    const api = { resolveWorkflow, findPlateRule };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
