# improve-detroit

"You Can't Park There" -- reports bike lane obstructions to the City of Detroit
(Improve Detroit / SeeClickFix) and mirrors them to Bike Lane Uprising.

## Where the API keys live

None of the app's API keys are in this repo, and none of them are sent to the
browser. This repo is public, and `config.js` is also served verbatim to
anyone who loads the deployed site -- so anything put there is readable by
the whole internet.

Instead, `api/proxy.js` holds them and attaches the right one to each
outbound request. Every call that needs a credential goes through it (see
`proxyFetch` in `index.html`). The proxy only accepts requests carrying a
Firebase ID token for the authorized account, so the keys can't be spent by
someone hitting `/api/proxy` directly either.

### Vercel environment variables

Set these under **Project Settings -> Environment Variables** (all
environments), then redeploy:

| Variable | What it is | Where to get a new one |
| --- | --- | --- |
| `SEECLICKFIX_TOKEN` | SeeClickFix API token (files real tickets with the City) | SeeClickFix account settings |
| `PLATE_RECOGNIZER_API_KEY` | Plate Recognizer key (billable) | platerecognizer.com dashboard |
| `GOOGLE_MAPS_API_KEY` | Google Geocoding API key (billable) | Google Cloud Console -> Credentials |
| `GITHUB_ACTIONS_TOKEN` | Fires the submit-to-blu/submit-to-bikebureau workflows on demand from the app's Sync menu | GitHub -> Settings -> Developer settings -> Fine-grained tokens; scope it to just this repo, "Actions: Read and write" permission only |
| `FIREBASE_PROJECT_ID` | Optional; defaults to `improve-detroit` | -- |

The Gemini and MailStream keys are separate: they're read at runtime from
Firestore (`config/secrets`), set via the Firebase Console. See the comments
in `config.js`.

### Rotating a key

Any key that was ever committed to this repo should be treated as public --
git history keeps it even after it's removed from the current files. Generate
a replacement at the provider, put the new value in the Vercel variable
above, and revoke the old one.

## Tests

`npm install` then:

- `npm test` -- runs the unit tests (`test/*.test.js`, via [Vitest](https://vitest.dev)):
  pure logic extracted into `lib/*.js` (geofence math, day/time windows,
  plate/company/USDOT normalization, HTML escaping, permit dedup/sorting,
  workflow/plate-rule resolution, history filtering), `api/proxy.js`'s
  auth/host-allowlist/credential-injection behavior (mocked Firebase Admin +
  `fetch`, no real network or project needed), and the pure helpers inside
  `scripts/*.js`. Runs in CI on every push/PR.
- `npm run test:coverage` -- the same suite with a line-coverage report
  (text + `coverage/index.html`), scoped to `lib/`, `api/`, and `scripts/`
  (index.html's own inline app script and the Playwright-driven parts of
  `scripts/*.js` are intentionally out of scope for line coverage -- see
  `test/e2e/golden-path.js` and the rules tests for how those are covered
  instead).
- `npm run test:rules` -- runs `test/firestore.rules.test.js`,
  `test/storage.rules.test.js`, and `test/scripts.integration.test.js`
  against the Firebase emulator (via `firebase emulators:exec`): the rules
  tests assert the actual owner-only access control
  firestore.rules/storage.rules enforce; the integration tests exercise
  each `scripts/*.js`'s actual Firestore-writing logic (`backfillPlates`,
  `seedGeofences`, `tagGeofenceOnIssues`, `importIssues`) against the
  emulator via the real `firebase-admin` SDK, which -- like these scripts in
  production -- always bypasses `firestore.rules`, so no service
  account/Auth emulator is needed. Needs a JDK on PATH (the emulator
  requires Java); also runs in CI.
- `npm run test:e2e` -- a Playwright smoke test
  (`test/e2e/golden-path.js`) driving the real, unmodified `index.html` in
  headless Chromium: loads, signs in (stubbed Firebase Auth), switches
  tabs, and selects a photo -- asserting it reaches `addQueueItem`/
  `mountItemCard` the way v3.15.1's fix confirmed it should (that exact
  path silently broke in production once). The CDN hosts the app depends
  on (Firebase, Leaflet, exifr, Tailwind) are stubbed with minimal fakes
  via `page.route()`, since this sandbox's (and possibly your CI runner's)
  network policy may not reach them; everything else -- the real
  `index.html`/`lib/*.js` -- runs unmodified. Deliberately scoped to a
  smoke test, not a full submission round-trip: it does not exercise
  `processQueueItem`'s async Gemini/Plate Recognizer/geocoding chain, which
  would need a much larger stub surface for comparatively little
  regression-catching value over the unit tests already covering that
  logic's pure pieces. Needs Playwright's Chromium installed
  (`npx playwright install chromium`, or the CI step that does the same);
  also runs in CI.

`lib/*.js` is loaded by `index.html` as plain `<script src="lib/...">` tags
(same as before this code was pulled out of the inline app script) so there's
still no build step -- it's also `require()`-able from Node, which is what
makes it unit-testable and lets `scripts/backfill-plates.js` share
`lib/identity.js`'s plate normalization with the live app instead of keeping
its own copy that could quietly drift out of sync. A few of these
(`resolveWorkflow`, `findPlateRule`, `applyHistoryFilters`) originally read
app-global state (`CONFIG`, `geofencesCache`, `historyFilters`) directly;
they now take that state as explicit parameters instead, purely so they're
testable -- their behavior is unchanged, see each call site in `index.html`.

## Scripts

See `package.json`. All of them need a Firebase service account key
(Firebase Console -> Project settings -> Service accounts), passed with
`--service-account`; never commit it.

- `npm run submit-to-blu` -- mirrors pending reports to Bike Lane Uprising
  (also runs twice daily via GitHub Actions, and can be queued on demand
  from the app's hamburger menu -> Sync -> "Sync to Bike Lane Uprising Now",
  which just fires the same workflow via the GitHub API -- see
  `GITHUB_ACTIONS_TOKEN` above and `triggerSyncWorkflow` in index.html)
- `npm run submit-to-bikebureau` -- mirrors pending reports to Bike Bureau
  (loudbicycle.com/bb; also runs twice daily via GitHub Actions). Unlike BLU
  this needs no site login of its own (no `BLU_EMAIL`/`BLU_PASSWORD`
  equivalent) -- the submit form is a guest upload, and Bike Bureau reads
  plate/date/location straight from the photo's own EXIF/pixels
  client-side. Still needs the same Firebase service account as the other
  scripts. A signed-out session can show a Cloudflare "Verify you are
  human" check on pretty much any submission (in one real run, roughly 1 in
  6 got through clean); this script never solves or bypasses it itself (and
  won't try to sign in first to avoid it either -- Google blocks sign-in
  from any automation-controlled browser outright). In `--headed` mode it
  pauses and waits (5 minutes by default) for you to click the checkbox
  yourself, then continues; headless, it has no one to do that, so it stops
  the whole run (exit code 2) instead of burning through the rest one by
  one. Same stop-instead-of-mis-marking treatment applies if the
  browser/tab itself dies mid-run. Either way, whatever's left stays
  `bikeBureauStatus: 'pending'` for the next run -- given how often the
  check shows up, `--headed` is the practical way to get through a large
  batch. `--channel chrome` and `--user-data-dir <path>` are also available
  if you'd rather it drive a real Chrome install/profile instead of
  Playwright's bundled Chromium and a throwaway profile -- neither is known
  to actually help with the Cloudflare check or the (unrelated, unfixable)
  Google sign-in block, they're just options if you want to try.
- `npm run import-history` -- imports past SeeClickFix submissions
- `npm run backfill-plates` -- rebuilds the plate index over old history
- `npm run seed-geofences` -- seeds the starting geofence set
