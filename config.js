/**
 * You Can't Park There -- configuration
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
        // "Potholes" (id 7047) -- also used, deliberately, for any non-vehicle
        // bike lane issue (glass, sand, garbage bins, construction debris,
        // actual potholes, etc.). Counterintuitive, but this is the request
        // type that routes to Detroit's General Services Dept, who handle
        // non-parking-related bike lane maintenance. See classifyPhotoWithGemini()
        // and the "other" branch of processQueueItem() in index.html.
        potholeRequestTypeId: '7047',
    },

    googleMapsApiKey: 'AIzaSyAts-aj_Ezg_OtGj05Tkh8kXRLPUcA9fAg',
    plateRecognizerApiKey: 'be8e6058bc8eeaced36a7a269e2f1e1337074bf7',
    // geminiApiKey is intentionally NOT here. It's a service-account-bound
    // key, so committing it to a public GitHub repo gets it auto-revoked by
    // Google's abuse scanner (this happened once already). Instead it's
    // fetched at runtime from Firestore (config/secrets, field
    // "geminiApiKey") after sign-in -- see index.html's geminiKeyReady/
    // onAuthStateChanged. Set it once via the Firebase Console; the app
    // only ever reads it (see firestore.rules -- no client write is
    // allowed on /config/*).

    historyKey: 'clearTheLaneHistory',

    // Submission history syncs to this Firestore project (anonymous auth,
    // one document per issue under users/{uid}/history) so it's shared
    // across every device you open the app on. localStorage is kept only
    // as an offline read cache -- see persistHistory()/loadHistoryFromStorage().
    firebase: {
        apiKey: 'AIzaSyDomyqjke15Jd_C8JQTzuEaCSRM3XGULe4',
        authDomain: 'improve-detroit.firebaseapp.com',
        projectId: 'improve-detroit',
        storageBucket: 'improve-detroit.firebasestorage.app',
        messagingSenderId: '587325235412',
        appId: '1:587325235412:web:ec6eedf95007ca63ea5b41',
    },

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
            'Vehicle illegally parked in bike lane near {{ADDRESS}}, violating Detroit City Code Sec. 55-6-7(a)(13) and obstructing bicycle traffic.',
            'Bicycle lane obstruction at {{ADDRESS}}. Vehicle is illegally stopped/parked in violation of Detroit City Code Sec. 55-6-7.',
        ],
    },

    // Any photo taken within `radiusMeters` of (lat, lng) uses `workflow`
    // instead of defaultWorkflow. Fields a geofence's workflow leaves out
    // (e.g. `summary`) fall back to defaultWorkflow's value. Add more
    // entries here for additional locations -- no code changes needed. The
    // first matching geofence wins if more than one overlaps.
    geofences: [
        {
            // Sexy Steak's valet at the GAR Building, 1942 Grand River.
            id: 'gar-building',
            name: 'GAR Building valet staging',
            lat: 42.33494474658147,
            lng: -83.05480479874544,
            radiusMeters: 100,
            workflow: {
                descriptions: [
                    'Valet operator at the GAR Building (Sexy Steak, 1942 Grand River) is using the Grand River bicycle lane as a staging area, blocking the bike lane. This is a recurring problem -- see previous {{PRIOR_COMPLAINTS}}.',
                ],
                // Bike Lane Uprising's "Obstruction Type" category for this
                // report -- must exactly match one of the option labels on
                // bikelaneuprising.com/submit (see scripts/submit-to-blu.js).
                // Falls back to "Private Owner Vehicle" for any workflow
                // that doesn't set this (defaultWorkflow included).
                bluCategory: 'Company Vehicle',
                // priorComplaintIds is NOT set here -- it's computed at
                // runtime in index.html from every synced history entry
                // whose geofenceId matches this geofence's id ('gar-building'),
                // so the citation list grows automatically as reports are
                // submitted from any device, with no config/code change
                // needed. See getPriorComplaintIdsForGeofence() and
                // scripts/tag-geofence.js (for backfilling old reports that
                // predate this app version and so were never auto-tagged).
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
