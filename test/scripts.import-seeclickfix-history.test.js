const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, readHarJson, loadIssuesFromHar, toHistoryEntry } = require('../scripts/import-seeclickfix-history.js');

describe('import-seeclickfix-history parseArgs', () => {
    it('defaults email', () => {
        expect(parseArgs([])).toEqual({ email: 'aschubatis@gmail.com' });
    });

    it('parses --har and --service-account', () => {
        const args = parseArgs(['--har', 'x.har', '--service-account', 'key.json']);
        expect(args.har).toBe('x.har');
        expect(args['service-account']).toBe('key.json');
    });
});

describe('readHarJson', () => {
    it('parses plain-text JSON response content', () => {
        const entry = { response: { content: { text: '{"issues":[{"id":1}]}' } } };
        expect(readHarJson(entry)).toEqual({ issues: [{ id: 1 }] });
    });

    it('decodes base64-encoded response content', () => {
        const json = '{"issues":[{"id":2}]}';
        const entry = { response: { content: { text: Buffer.from(json).toString('base64'), encoding: 'base64' } } };
        expect(readHarJson(entry)).toEqual({ issues: [{ id: 2 }] });
    });
});

describe('toHistoryEntry', () => {
    it('maps a SeeClickFix issue into the history doc shape', () => {
        const issue = {
            id: 123,
            address: '1 Main St',
            created_at: '2024-01-01T00:00:00Z',
            status: 'Open',
            html_url: 'https://seeclickfix.com/issues/123',
            media: { image_square_100x100: 'thumb.jpg' },
        };
        expect(toHistoryEntry(issue)).toEqual({
            thumbnail: 'thumb.jpg',
            address: '1 Main St',
            submittedAt: '2024-01-01T00:00:00Z',
            status: 'Open',
            link: 'https://seeclickfix.com/issues/123',
        });
    });

    it('falls back to representative_image_url when no square thumbnail exists', () => {
        const issue = { id: 1, media: { representative_image_url: 'full.jpg' } };
        expect(toHistoryEntry(issue).thumbnail).toBe('full.jpg');
    });

    it('builds a seeclickfix.com link when html_url is missing', () => {
        const issue = { id: 456 };
        expect(toHistoryEntry(issue).link).toBe('https://seeclickfix.com/issues/456');
    });

    it('defaults status to Unknown and address to empty string', () => {
        const issue = { id: 1 };
        const entry = toHistoryEntry(issue);
        expect(entry.status).toBe('Unknown');
        expect(entry.address).toBe('');
    });
});

describe('loadIssuesFromHar', () => {
    it('extracts and dedupes issues from profile/issues API entries only', () => {
        const har = {
            log: {
                entries: [
                    {
                        request: { url: 'https://seeclickfix.com/api/v2/profile/issues?page=1' },
                        response: { content: { text: JSON.stringify({ issues: [{ id: 1 }, { id: 2 }] }) } },
                    },
                    {
                        // Not a profile/issues call -- must be ignored.
                        request: { url: 'https://seeclickfix.com/api/v2/other' },
                        response: { content: { text: JSON.stringify({ issues: [{ id: 999 }] }) } },
                    },
                    {
                        request: { url: 'https://seeclickfix.com/api/v2/profile/issues?page=2' },
                        response: { content: { text: JSON.stringify({ issues: [{ id: 2 }, { id: 3 }] }) } },
                    },
                ],
            },
        };
        const tmpFile = path.join(os.tmpdir(), `har-test-${Date.now()}.har`);
        fs.writeFileSync(tmpFile, JSON.stringify(har));
        try {
            const issues = loadIssuesFromHar(tmpFile);
            expect(issues.map((i) => i.id).sort()).toEqual([1, 2, 3]);
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });

    it('skips entries whose content does not parse as JSON, without throwing', () => {
        const har = {
            log: {
                entries: [
                    {
                        request: { url: 'https://seeclickfix.com/api/v2/profile/issues' },
                        response: { content: { text: 'not json' } },
                    },
                ],
            },
        };
        const tmpFile = path.join(os.tmpdir(), `har-test-bad-${Date.now()}.har`);
        fs.writeFileSync(tmpFile, JSON.stringify(har));
        try {
            expect(loadIssuesFromHar(tmpFile)).toEqual([]);
        } finally {
            fs.rmSync(tmpFile, { force: true });
        }
    });
});
