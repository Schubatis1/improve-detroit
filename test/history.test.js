const { isBluLocked, parkingDeptStatusCategory, applyHistoryFilters } = require('../lib/history.js');

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

describe('applyHistoryFilters', () => {
    it('passes everything through with no active filters', () => {
        expect(applyHistoryFilters({ bluStatus: 'submitted' }, {})).toBe(true);
    });

    it('filters by parkingDept status (derived via parkingDeptStatusCategory)', () => {
        const filters = { parkingDept: 'awaiting' };
        expect(applyHistoryFilters({ parkingDeptFlag: 'flagged' }, filters)).toBe(true);
        expect(applyHistoryFilters({ parkingDeptFlag: 'notified' }, filters)).toBe(false);
    });

    it('filters by exact bluStatus', () => {
        const filters = { bluStatus: 'submitted' };
        expect(applyHistoryFilters({ bluStatus: 'submitted' }, filters)).toBe(true);
        expect(applyHistoryFilters({ bluStatus: 'failed' }, filters)).toBe(false);
        expect(applyHistoryFilters({}, filters)).toBe(false);
    });

    it('filters by exact status', () => {
        const filters = { status: 'Open' };
        expect(applyHistoryFilters({ status: 'Open' }, filters)).toBe(true);
        expect(applyHistoryFilters({ status: 'Closed' }, filters)).toBe(false);
    });

    it('filters by geofenceId, with a special "__none__" sentinel for unlinked entries', () => {
        const byGeofence = { geofenceId: 'gar-building' };
        expect(applyHistoryFilters({ geofenceId: 'gar-building' }, byGeofence)).toBe(true);
        expect(applyHistoryFilters({ geofenceId: 'times-square' }, byGeofence)).toBe(false);
        expect(applyHistoryFilters({}, byGeofence)).toBe(false);

        const unlinkedOnly = { geofenceId: '__none__' };
        expect(applyHistoryFilters({}, unlinkedOnly)).toBe(true);
        expect(applyHistoryFilters({ geofenceId: 'gar-building' }, unlinkedOnly)).toBe(false);
    });

    it('filters by an inclusive date range, by calendar day', () => {
        const filters = { dateFrom: '2024-06-01', dateTo: '2024-06-30' };
        expect(applyHistoryFilters({ submittedAt: '2024-06-15T12:00:00' }, filters)).toBe(true);
        expect(applyHistoryFilters({ submittedAt: '2024-06-01T00:00:00' }, filters)).toBe(true);
        expect(applyHistoryFilters({ submittedAt: '2024-06-30T23:59:00' }, filters)).toBe(true);
        expect(applyHistoryFilters({ submittedAt: '2024-05-31T23:00:00' }, filters)).toBe(false);
        expect(applyHistoryFilters({ submittedAt: '2024-07-01T00:01:00' }, filters)).toBe(false);
    });

    it('requires every active filter to match (AND, not OR)', () => {
        const filters = { bluStatus: 'submitted', status: 'Open' };
        expect(applyHistoryFilters({ bluStatus: 'submitted', status: 'Open' }, filters)).toBe(true);
        expect(applyHistoryFilters({ bluStatus: 'submitted', status: 'Closed' }, filters)).toBe(false);
    });
});
