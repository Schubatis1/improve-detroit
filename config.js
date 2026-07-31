/**
 * Clear the Lane -- configuration
 *
 * Everything site-specific and likely to change lives here: API keys/IDs,
 * geofences, and the message pools each workflow pulls from. index.html
 * only contains app logic that reads this file -- adding a geofence, a
 * plate rule, or new message wording should never require touching
 * index.html.
 *
 * Loaded as a plain global (window.APP_CONFIG) so it still works from a
 * file:// page with no build step. Reload the page after editing.
 */
window.APP_CONFIG = {
    seeClickFix: {
        token: 'token-07/31/2026-07/30/2027--B10B9B5D01CC998EE5A6C6BB8266537173326DC0F21EFE605455E64047D75A81-1',
        requestTypeId: '22880',
        natureQuestionId: '32751',
        timingQuestionId: '33446',
    },

    googleMapsApiKey: 'AIzaSyAts-aj_Ezg_OtGj05Tkh8kXRLPUcA9fAg',
    plateRecognizerApiKey: 'be8e6058bc8eeaced36a7a269e2f1e1337074bf7',

    historyKey: 'clearTheLaneHistory',

    // Applied to every photo that doesn't match a more specific geofence
    // below. `descriptions` is a pool of message templates -- one is chosen
    // at random per photo. Use {{ADDRESS}} as a placeholder for the
    // resolved street address.
    defaultWorkflow: {
        summary: 'Vehicle Blocking Bike Lane',
        descriptions: [
            'Vehicle illegally parked in bike lane near {{ADDRESS}}, obstructing bicycle traffic in violation of Mich. Admin. Code R. 28.1322.',
            'Bike lane obstruction reported at {{ADDRESS}}. Vehicle is impeding the active lane and pushing cyclists into motor traffic.',
            'Illegal parking in dedicated bicycle lane at {{ADDRESS}}. Path of travel is obstructed.',
            'Active traffic hazard at {{ADDRESS}}: Vehicle parked in designated bike lane, violating MCL 257.676b (impeding traffic).',
            'Bicycle lane obstruction near {{ADDRESS}}. Vehicle is illegally stopped/parked, impeding cyclist right-of-way.',
            'Cyclist safety concern at {{ADDRESS}}: Vehicle parked in the bike lane in violation of Mich. Admin. Code R. 28.1322, compromising the travel lane.',
            'Illegal vehicle obstruction in bike lane at {{ADDRESS}}. Requesting enforcement under MCL 257.676b to clear the travel lane.',
            'Bicycle lane obstruction near {{ADDRESS}}. Vehicle is illegally parked, posing a safety hazard to non-motorized transportation.',
            'Vehicle blocking designated bike lane near {{ADDRESS}}, violating local traffic codes and Mich. Admin. Code R. 28.1322.',
            'Traffic code violation at {{ADDRESS}}: Vehicle illegally parked in bicycle lane, obstructing the designated path.',
        ],
    },

    // Any photo taken within `radiusMeters` of (lat, lng) uses `workflow`
    // instead of defaultWorkflow. Fields a geofence's workflow leaves out
    // (e.g. `summary`) fall back to defaultWorkflow's value. Add more
    // entries here for additional locations -- no code changes needed. The
    // first matching geofence wins if more than one overlaps.
    geofences: [
        {
            id: 'gar-building',
            name: 'GAR Building valet staging',
            lat: 42.33494474658147,
            lng: -83.05480479874544,
            radiusMeters: 100,
            workflow: {
                descriptions: [
                    'Valet operator at GAR building is inappropriately using Grand River bicycle lane for valet staging.',
                ],
            },
        },
    ],

    // Checked once a plate is OCR'd from the photo. Each rule's `plates`
    // list is matched against the detected plate (uppercased, spaces
    // stripped). The first matching rule's `workflow` is applied on top of
    // whatever geofence/default workflow already resolved -- but only if
    // the user hasn't started editing the pre-filled description. Add
    // entries here for plate-specific handling (e.g. known repeat
    // offenders); leave the array empty to disable plate-driven workflows.
    plateRules: [
        // {
        //     id: 'repeat-offender-example',
        //     name: 'Example repeat offender',
        //     plates: ['ABC1234'],
        //     workflow: {
        //         descriptions: [
        //             'Repeat violation: vehicle with plate ABC1234 illegally parked in bike lane at {{ADDRESS}}. This vehicle has been previously reported for the same violation.',
        //         ],
        //     },
        // },
    ],
};
