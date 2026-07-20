# npm Version Dashboard

A static, evidence-preserving dashboard for npm downloads **by package version**. It exists because package-total trend tools do not show how downloads move between releases.

The dashboard is seeded with [`modern-web-guidance`](https://www.npmjs.com/package/modern-web-guidance).

## Important data limitation

npm exposes per-version counts only for a rolling seven-day period:

```text
https://api.npmjs.org/versions/{package}/last-week
```

There is no historical per-version backfill. This project creates history by taking one immutable snapshot every Monday. The API does not report exact start/end timestamps, and npm data can lag, so these are labelled **rolling seven-day snapshots**, not exact calendar weeks.

Package-total history can be backfilled through npm's range API, but that cannot reconstruct historical version shares.

## Add packages

Edit [`config/packages.json`](config/packages.json):

```json
{
  "packages": [
    {
      "name": "modern-web-guidance",
      "label": "Modern Web Guidance",
      "group": "Chrome DevRel",
      "important": true
    },
    {
      "name": "@scope/package",
      "label": "A scoped package",
      "group": "Team name"
    }
  ]
}
```

Scoped names are encoded as a single URL segment when querying npm.

## Collect locally

Requires Node.js 22 or later and no runtime dependencies.

```sh
npm install
npm test
npm run collect
```

Collection:

1. reads the package inventory;
2. fetches each package independently with timeout, retries, and exponential backoff;
3. records successful and failed packages without dropping other results;
4. writes `data/snapshots/YYYY-MM-DD.json` atomically and never overwrites it;
5. rebuilds `data/dashboard.json` and `docs/data/dashboard.json`.

A second run on the same UTC date is idempotent and does not rewrite the snapshot.

## Automation

- `.github/workflows/collect.yml` runs every Monday at 09:17 UTC and supports manual dispatch.
- `.github/workflows/deploy.yml` deploys `docs/` to GitHub Pages.

The collector needs only the public npm APIs. The workflow's write permission is limited to committing data snapshots.

## Dashboard accessibility

Charts are visual summaries. Every chart has a semantic table containing the same data. The page uses native controls, landmarks, visible focus, responsive intrinsic layout, reduced-motion handling, and horizontal overflow for wide tables/charts.

## What the dashboard shows

- rolling seven-day package downloads;
- week-over-week total change;
- version share over time;
- latest-version adoption share;
- number of downloaded versions;
- top version per snapshot;
- release dates for observed versions in raw data;
- explicit failed collection states and source caveats.

## License

Apache-2.0
