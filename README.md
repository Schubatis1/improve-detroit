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
| `FIREBASE_PROJECT_ID` | Optional; defaults to `improve-detroit` | -- |

The Gemini and MailStream keys are separate: they're read at runtime from
Firestore (`config/secrets`), set via the Firebase Console. See the comments
in `config.js`.

### Rotating a key

Any key that was ever committed to this repo should be treated as public --
git history keeps it even after it's removed from the current files. Generate
a replacement at the provider, put the new value in the Vercel variable
above, and revoke the old one.

## Scripts

See `package.json`. All of them need a Firebase service account key
(Firebase Console -> Project settings -> Service accounts), passed with
`--service-account`; never commit it.

- `npm run submit-to-blu` -- mirrors pending reports to Bike Lane Uprising
  (also runs twice daily via GitHub Actions)
- `npm run import-history` -- imports past SeeClickFix submissions
- `npm run backfill-plates` -- rebuilds the plate index over old history
- `npm run seed-geofences` -- seeds the starting geofence set
