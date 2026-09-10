// Pure text/template helpers shared by index.html and the test suite.
(function (globalObj) {
    'use strict';

    // HTML-escapes plain text for safe interpolation into a template
    // string that gets assigned to innerHTML elsewhere in the app (report
    // descriptions, comments, permit data, etc. all flow through this).
    // Originally implemented via a scratch <div>'s textContent/innerHTML
    // round-trip; reimplemented here as a plain string replace so it can
    // run outside a DOM (Node scripts, tests) -- order matters: "&" must
    // be escaped first, or the "&" produced by escaping "<"/">" would
    // itself get re-escaped. This mirrors the WHATWG HTML fragment
    // serialization algorithm's handling of Text nodes, which is what the
    // DOM round-trip was relying on (only &, <, > are special outside an
    // attribute context -- quotes are left alone).
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Turns a workflow's priorComplaintIds (e.g. for a recurring-offender
    // geofence) into a phrase like "issue #123" or "issues #123, #456,
    // and #789" for the {{PRIOR_COMPLAINTS}} placeholder below.
    function formatPriorComplaints(ids) {
        if (!ids || ids.length === 0) return 'incidents at this location';
        if (ids.length === 1) return `issue #${ids[0]}`;
        const numbered = ids.map((id) => `#${id}`);
        const last = numbered.pop();
        return `issues ${numbered.join(', ')}${ids.length > 2 ? ',' : ''} and ${last}`;
    }

    // Picks one random template from a workflow's description pool and
    // fills in the resolved address and (if the workflow defines any)
    // prior-complaint issue numbers.
    function pickRandomDescription(workflow, address) {
        const template = workflow.descriptions[Math.floor(Math.random() * workflow.descriptions.length)];
        return template
            .replace(/\{\{ADDRESS\}\}/g, address)
            .replace(/\{\{PRIOR_COMPLAINTS\}\}/g, formatPriorComplaints(workflow.priorComplaintIds));
    }

    function parsePolygonPointsText(text) {
        return text.split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.split(',').map((n) => parseFloat(n.trim())))
            .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng))
            .map(([lat, lng]) => ({ lat, lng }));
    }

    function polygonPointsToText(points) {
        return points.map((p) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`).join('\n');
    }

    const api = {
        escapeHtml,
        formatPriorComplaints,
        pickRandomDescription,
        parsePolygonPointsText,
        polygonPointsToText,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        Object.assign(globalObj, api);
    }
})(typeof window !== 'undefined' ? window : globalThis);
