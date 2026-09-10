// @vitest-environment jsdom
//
// escapeHtml was originally implemented via a scratch <div>'s
// textContent/innerHTML round-trip (see index.html's pre-extraction
// history). lib/format.js reimplements it as a plain string replace so it
// can run outside a DOM -- this file cross-checks the two against a real
// DOM (via jsdom) to make sure the extraction didn't change behavior.
const { escapeHtml } = require('../lib/format.js');

function domEscapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

describe('escapeHtml matches the original DOM-based implementation', () => {
    const cases = [
        'plain text',
        '<script>alert(1)</script>',
        'Tom & Jerry',
        `it's "quoted" & <b>bold</b>`,
        '&amp; already escaped &lt;',
        '',
        '   leading/trailing spaces   ',
        'unicode: café 🚲',
        '<<>>&&',
    ];

    for (const str of cases) {
        it(`matches for ${JSON.stringify(str)}`, () => {
            expect(escapeHtml(str)).toBe(domEscapeHtml(str));
        });
    }
});
