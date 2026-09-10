// Pure geospatial/time-window helpers shared by index.html (loaded as a
// plain <script> global, same as before extraction) and the test suite
// (loaded via require()). No DOM, no app state -- every input is a
// parameter. See index.html's original inline definitions for the
// behavioral comments this was extracted from; kept verbatim here.
(function (globalObj) {
    'use strict';

    function distanceMeters(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const toRad = (deg) => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Ray-casting point-in-polygon test (even-odd rule). `polygon` is an
    // ordered array of {lat, lng} vertices -- the last vertex connects
    // back to the first implicitly, so callers don't need to repeat it.
    // Good enough for the small, city-block-scale shapes geofences use;
    // doesn't need to account for antimeridian wraparound or geodesic
    // curvature at this scale.
    function pointInPolygon(lat, lng, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const a = polygon[i], b = polygon[j];
            const crosses = (a.lat > lat) !== (b.lat > lat)
                && lng < (b.lng - a.lng) * (lat - a.lat) / (b.lat - a.lat) + a.lng;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    function polygonCentroid(polygon) {
        return {
            lat: polygon.reduce((sum, p) => sum + p.lat, 0) / polygon.length,
            lng: polygon.reduce((sum, p) => sum + p.lng, 0) / polygon.length,
        };
    }

    // Whether (lat, lng) falls inside a geofence's shape. Geofences with
    // 3+ points in `polygon` use a true point-in-polygon test; every
    // other geofence (the original/default shape) falls back to the
    // classic center point + radiusMeters circle. lat/lng on a polygon
    // geofence still holds its centroid (see saveGeofenceForm), just for
    // map centering/list display -- matching itself uses the polygon.
    function geofenceContainsPoint(geofence, lat, lng) {
        if (Array.isArray(geofence.polygon) && geofence.polygon.length >= 3) {
            return pointInPolygon(lat, lng, geofence.polygon);
        }
        return distanceMeters(lat, lng, geofence.lat, geofence.lng) <= geofence.radiusMeters;
    }

    // Whether a geofence document is "active" (per its daysOfWeek/
    // startHour/endHour fields, all optional) at a given Date, in
    // Detroit local time -- `when` should be the photo's own
    // capture time (item.photoDateObj), not upload time, since a
    // "Sexy Steak Geofence should be active after 2pm" rule is about
    // when the obstruction was photographed, not when it's processed.
    // daysOfWeek empty/absent = every day. startHour/endHour both
    // null/absent = 24 hours. Only one of startHour/endHour set means
    // "from startHour to end of day" or "from start of day to endHour".
    // startHour > endHour is treated as an overnight window (e.g. 22-2).
    function geofenceActiveAt(geofence, when) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Detroit', weekday: 'short', hour: 'numeric', hour12: false,
        }).formatToParts(when);
        const weekdayAbbr = parts.find((p) => p.type === 'weekday').value;
        const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayAbbr);
        const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;

        const days = geofence.daysOfWeek;
        if (Array.isArray(days) && days.length > 0 && !days.includes(dayIndex)) return false;

        const start = geofence.startHour;
        const end = geofence.endHour;
        if (start == null && end == null) return true;
        if (start != null && end == null) return hour >= start;
        if (start == null && end != null) return hour < end;
        return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
    }

    // Bike Lane Uprising's "Metro City" dropdown option labels, copied
    // verbatim from the live form (see scripts/submit-to-blu.js's
    // PLATE_STATE_*/METRO_CITY_DETROIT comment) -- must match exactly.
    const METRO_CITY_DETROIT = 'Detroit - MI';
    const METRO_CITY_NEW_YORK = 'New York - NY';

    // Rough bounding box covering all five NYC boroughs, generously
    // padded -- good enough to tell "this photo was taken on a work
    // trip to New York" from "this is Detroit", without needing a
    // reverse-geocode round trip just to pick a metro city.
    const NEW_YORK_CITY_BOUNDS = { minLat: 40.47, maxLat: 40.92, minLng: -74.26, maxLng: -73.68 };

    function resolveMetroCity(lat, lng) {
        const b = NEW_YORK_CITY_BOUNDS;
        if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) {
            return METRO_CITY_NEW_YORK;
        }
        return METRO_CITY_DETROIT;
    }

    const api = {
        distanceMeters,
        pointInPolygon,
        polygonCentroid,
        geofenceContainsPoint,
        geofenceActiveAt,
        resolveMetroCity,
        METRO_CITY_DETROIT,
        METRO_CITY_NEW_YORK,
        NEW_YORK_CITY_BOUNDS,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
