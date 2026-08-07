/**
 * You Can't Park There -- configuration
 *
 * Everything site-specific and likely to change lives here: API keys/IDs,
 * plate rules, and the message pools each workflow pulls from. index.html
 * only contains app logic that reads this file -- adding a plate rule or
 * new message wording should never require touching index.html.
 * (Geofences used to live here too, but are now fully managed from the
 * app's Geofence Maintenance screen and stored in Firestore -- see the
 * comment further down.)
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

    // Geofences used to live here as a static array, but that meant every
    // add/edit/delete required a code change + redeploy. They now live in
    // Firestore (users/{uid}/geofences), managed from the app itself via
    // the Geofence Maintenance screen (hamburger menu) -- see index.html's
    // initGeofencesSync/resolveWorkflow/geofenceActiveAt. Each geofence
    // document holds: name, lat, lng, radiusMeters, message (supports
    // {{ADDRESS}} and {{PRIOR_COMPLAINTS}} placeholders, same as before),
    // bluCategory, improveDetroitCategory, daysOfWeek, startHour/endHour
    // (time-of-day bounds, both null = 24/7), and
    // detect/reportRepeatOffenders + detect/reportRepeatIncidents booleans.
    // The first matching *and currently active* geofence wins if more than
    // one overlaps. Run scripts/seed-geofences.js once against a fresh
    // Firestore project to create the starting set (GAR Building valet
    // staging + the Times Square geofence).

    // Bike Lane Uprising's "Obstruction Type" options, copied verbatim from
    // bikelaneuprising.com/submit (see scripts/submit-to-blu.js, which
    // selects by this exact label text). Shared by the per-report BLU
    // Category field and the Geofence Maintenance form so both stay in
    // sync with one edit.
    bluCategories: [
        'Private Owner Vehicle',
        'Company Vehicle',
        'Construction',
        'Municipal (city) Vehicle - includes USPS',
        'Taxi / Uber / Livery / Lyft',
        'Other  (damaged lane / snow / debris / pedestrian / etc.)',
    ],

    // "Notify Parking Dept" (hamburger menu) -- policy/wording for scanning
    // past reports for the City's boilerplate "car gone on arrival, contact
    // Municipal Parking Department Enforcement" reply and generating a
    // mailable letter. This is the wording/policy half only -- the sender's
    // and recipient's actual mailing addresses are PII and deliberately
    // live in Firestore instead (users/{uid}/settings/parkingDeptLetter,
    // edited from the app), never here, for the same reason geminiApiKey
    // isn't here: this file is committed to a public repo.
    parkingDeptLetter: {
        // Case-insensitive substring match against a comment's text --
        // checked before ever calling Gemini (see classifyCommentWithGemini
        // in index.html), so a normal run costs nothing extra. Seeded from
        // a real example: "...Car gone on arrival. No violations at this
        // time. City of Detroit Municipal Parking Department Enforcement
        // phone number is 313-221-2558."
        keywordTriggers: [
            'Municipal Parking Department',
        ],
        parkingDeptPhone: '313-221-2558',
        // Search (hamburger menu -> Notify Parking Dept -> Search) checks
        // at most this many not-yet-flagged issues per tap, least-recently-
        // checked first -- same reasoning as scripts/submit-to-blu.js's
        // --limit 10 default: keeps an on-demand mobile action fast; tap
        // Search again for more.
        searchCapPerRun: 15,
        // Letter template text. {{DATE}}/{{GEOFENCE_NAME}}/{{LETTER_DATE}}
        // are filled in by buildParkingDeptLetterModel()/the docx builder.
        letterIntro: 'I am writing to follow up on a number of bicycle lane obstruction incidents I previously reported to the City of Detroit through the Improve Detroit system. In each case, the responding officer noted that the vehicle was gone on arrival and directed me to contact the City of Detroit Municipal Parking Department Enforcement directly, since no violation could be issued after the fact. I am providing the details below so that these recurring problem locations and vehicles can be addressed going forward.',
        letterClosing: 'Please let me know if any additional information is needed. Thank you for your attention to these recurring obstructions.',
        geofenceSectionIntro: 'The following incident(s) occurred at {{GEOFENCE_NAME}}:',
        miscSectionHeading: 'Miscellaneous Parking Violations',
        repeatOffendersSectionHeading: 'Repeat Offenders',
        // Posted back to SeeClickFix by "Mark as Notified" -- {{LETTER_DATE}}
        // is always the letter's own stored generation date, never the date
        // the comment is actually posted (which may be later).
        notifyCommentTemplate: 'Notified the City of Detroit Municipal Parking Enforcement Department about this recurring bike lane obstruction on {{LETTER_DATE}}.',
    },

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
