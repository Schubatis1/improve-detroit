const { resolveWorkflow, findPlateRule } = require('../lib/workflow.js');

describe('resolveWorkflow', () => {
    const defaultWorkflow = { summary: 'Vehicle Blocking Bike Lane', descriptions: ['Default near {{ADDRESS}}.'] };

    it('falls back to the default workflow with no matching geofence', () => {
        const { workflow, geofence } = resolveWorkflow(defaultWorkflow, [], 42.33, -83.05, new Date());
        expect(geofence).toBeUndefined();
        expect(workflow).toEqual(defaultWorkflow);
    });

    it('merges a matching, currently-active geofence over the default', () => {
        const geofences = [{
            id: 'gar-building', lat: 42.33, lng: -83.05, radiusMeters: 100,
            message: 'Valet staging near {{ADDRESS}}.', bluCategory: 'Company Vehicle', improveDetroitCategory: 'Custom Nature',
        }];
        const { workflow, geofence } = resolveWorkflow(defaultWorkflow, geofences, 42.33, -83.05, new Date());
        expect(geofence.id).toBe('gar-building');
        expect(workflow.descriptions).toEqual(['Valet staging near {{ADDRESS}}.']);
        expect(workflow.bluCategory).toBe('Company Vehicle');
        expect(workflow.natureValue).toBe('Custom Nature');
        expect(workflow.summary).toBe(defaultWorkflow.summary); // unset fields fall through
    });

    it('ignores a geofence that contains the point but is not active at `when`', () => {
        const geofences = [{
            id: 'after-hours', lat: 42.33, lng: -83.05, radiusMeters: 100,
            startHour: 22, endHour: 6, message: 'Should not apply.',
        }];
        // Wed Jan 7 2026, 15:00 UTC = 10:00 AM EST -- outside 22:00-06:00.
        const { workflow, geofence } = resolveWorkflow(defaultWorkflow, geofences, 42.33, -83.05, new Date('2026-01-07T15:00:00Z'));
        expect(geofence).toBeUndefined();
        expect(workflow).toEqual(defaultWorkflow);
    });

    it('ignores a geofence that does not contain the point', () => {
        const geofences = [{ id: 'far-away', lat: 0, lng: 0, radiusMeters: 10, message: 'Should not apply.' }];
        const { workflow, geofence } = resolveWorkflow(defaultWorkflow, geofences, 42.33, -83.05, new Date());
        expect(geofence).toBeUndefined();
        expect(workflow).toEqual(defaultWorkflow);
    });

    it('picks the first matching, active geofence when more than one overlaps', () => {
        const geofences = [
            { id: 'first', lat: 42.33, lng: -83.05, radiusMeters: 100, bluCategory: 'A' },
            { id: 'second', lat: 42.33, lng: -83.05, radiusMeters: 100, bluCategory: 'B' },
        ];
        const { geofence } = resolveWorkflow(defaultWorkflow, geofences, 42.33, -83.05, new Date());
        expect(geofence.id).toBe('first');
    });

    it('defaults `when` to now if omitted', () => {
        const { geofence } = resolveWorkflow(defaultWorkflow, [], 42.33, -83.05);
        expect(geofence).toBeUndefined();
    });
});

describe('findPlateRule', () => {
    const plateRules = [
        { id: 'repeat-offender', name: 'Known repeat offender', plates: ['ABC1234'], workflow: {} },
    ];

    it('finds a rule matching the normalized plate', () => {
        expect(findPlateRule('abc 1234', plateRules).id).toBe('repeat-offender');
        expect(findPlateRule('ABC1234', plateRules).id).toBe('repeat-offender');
    });

    it('returns null for no match', () => {
        expect(findPlateRule('XYZ9999', plateRules)).toBeNull();
    });

    it('returns null for an empty/unreadable plate without erroring', () => {
        expect(findPlateRule('', plateRules)).toBeNull();
        expect(findPlateRule(null, plateRules)).toBeNull();
    });

    it('returns null when plateRules is empty', () => {
        expect(findPlateRule('ABC1234', [])).toBeNull();
    });
});
