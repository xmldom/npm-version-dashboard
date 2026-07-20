# npm Version Dashboard

A Deno Deploy dashboard that tracks npm downloads **by package version**. It exists because package-total
trend tools do not show how downloads move between releases.

The dashboard is seeded with [`modern-web-guidance`](https://www.npmjs.com/package/modern-web-guidance).

## How collection works

A top-level `Deno.cron()` runs every day at **04:17 UTC**. For each tracked package it fetches:

- `api.npmjs.org/versions/{package}/last-week` — rolling seven-day counts by version;
- `api.npmjs.org/downloads/point/last-week/{package}` — exact inclusive window and package total;
- `api.npmjs.org/downloads/point/last-day/{package}` — exact latest daily package total;
- `registry.npmjs.org/{package}/latest` and, when needed, the packument — current release and publication
  dates.

The collector performs three-way reconciliation: per-version sum vs point total, daily range sum vs point
total, and exact window alignment across sources. It records `healthy`, `delayed`, or `mismatch` rather than
silently accepting inconsistent data. One package failure is retained without dropping successful package
results.

Snapshots are keyed by npm's reported window end date, so a retry is idempotent. Version maps are split into
bounded Deno KV chunks, checksummed, then made visible by an immutable manifest. A distributed KV lock
prevents overlapping cron/manual runs.

On first collection, exact daily package totals are backfilled from the package's publication date in bounded
365-day range requests. npm-wide daily totals are backfilled to 2015-01-10 and retained as a global
anomaly/normalization baseline. Subsequent runs only fetch missing days. Unscoped packages use bulk
point/range requests in groups of at most 128, with automatic individual fallback; scoped packages remain
isolated because npm does not support them in bulk.

## Important data limitation

npm exposes per-version counts only for a rolling seven-day period. `last-day`, `last-month`, `last-year`, and
custom date ranges are not supported by the per-version endpoint.

There is no historical per-version backfill. Daily snapshots provide an honest rolling version-share series,
but they do **not** uniquely identify exact daily counts for versions that predate tracking:

```text
W[t,v] - W[t-1,v] = D[t,v] - D[t-7,v]
```

Package-total history can be backfilled through npm's range API, but that cannot reconstruct historical
version shares. Any future per-version daily estimates must be labelled inferred and retain the raw
observations.

## Run locally

Requires Deno 2.8+.

```sh
deno task collect
deno task dev
```

Open `http://localhost:8000/`.

Checks:

```sh
deno fmt --check
deno lint
deno task check
npm test
```

The dependency-free Node scripts and JSON snapshot remain as a static/prototype compatibility path; Deno
Deploy uses `server.ts`, Deno KV, and `Deno.cron()`.

## Deploy on Deno Deploy

1. Create a Deno Deploy app from this GitHub repository.
2. Use `server.ts` as the production entrypoint.
3. Attach a Deno KV database/timeline if the project setup does not provision one automatically.
4. Deploy. Deno discovers the top-level daily cron registration.
5. Optionally set `ADMIN_TOKEN` as an encrypted environment variable. This enables an authenticated manual
   collection:

```sh
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR_APP/api/admin/collect
```

Without `ADMIN_TOKEN`, the manual endpoint returns 404. The cron does not need a secret.

Health and data endpoints:

- `GET /healthz`
- `GET /api/dashboard` — version snapshots, exact daily package history, and npm-wide baseline

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

Scoped names are encoded as a single URL segment when querying npm. A future authenticated UI can add per-user
package-follow records without duplicating package observations.

## Dashboard accessibility

Charts are visual summaries. Every chart has a semantic table containing the same data. The page uses native
controls, landmarks, visible focus, responsive intrinsic layout, reduced-motion handling, and bounded
horizontal overflow for wide tables/charts.

## Security

- static responses use a restrictive Content Security Policy and browser security headers;
- the manual collection endpoint is absent unless `ADMIN_TOKEN` is configured;
- package names originate from trusted config/KV records and are encoded before upstream requests;
- there is no anonymous mutation endpoint;
- collection has timeout, bounded retries, a lock, immutable manifests, checksums, and per-package failure
  isolation.

## License

Apache-2.0
