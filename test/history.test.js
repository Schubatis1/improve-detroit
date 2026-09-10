const { isBluLocked, parkingDeptStatusCategory } = require('../lib/history.js');

describe('isBluLocked', () => {
    it('is false while bluStatus is pending or unset', () => {
        expect(isBluLocked({})).toBe(false);
        expect(isBluLocked({ bluStatus: 'pending' })).toBe(false);
    });

    it('is true for any terminal bluStatus', () => {
        expect(isBluLocked({ bluStatus: 'submitted' })).toBe(true);
        expect(isBluLocked({ bluStatus: 'failed' })).toBe(true);
        expect(isBluLocked({ bluStatus: 'photo-upload-failed' })).toBe(true);
    });
});

describe('parkingDeptStatusCategory', () => {
    it('notified wins outright', () => {
        expect(parkingDeptStatusCategory({ parkingDeptFlag: 'notified' })).toBe('notified');
    });

    it('flagged or lettered means awaiting', () => {
        expect(parkingDeptStatusCategory({ parkingDeptFlag: 'flagged' })).toBe('awaiting');
        expect(parkingDeptStatusCategory({ parkingDeptFlag: 'lettered' })).toBe('awaiting');
    });

    it('dismissed means notRequested even if never checked', () => {
        expect(parkingDeptStatusCategory({ parkingDeptFlag: 'dismissed' })).toBe('notRequested');
    });

    it('checked with no flag means notRequested', () => {
        expect(parkingDeptStatusCategory({ parkingDeptLastCheckedAt: '2024-01-01T00:00:00Z' })).toBe('notRequested');
    });

    it('never checked and no flag means notDetermined', () => {
        expect(parkingDeptStatusCategory({})).toBe('notDetermined');
    });
});
