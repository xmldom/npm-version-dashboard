// One-time backfill of manually captured download baselines into Deno KV.
//
// SAFE TO REMOVE: delete this file, the `backfill/` directory, and the marked
// block in `server.ts`. Nothing else depends on it.
//
// For each configured package it looks for `backfill/<packageName>.json`
// (scoped names nest naturally, e.g. `backfill/@xmldom/xmldom.json`). When a
// snapshot for that week-window is not already stored, it seeds one from the
// file. Idempotent: `storeSnapshot` skips windows that already exist, so this
// is safe to run on every server start, including each Deno Deploy cold start.

import { type PackageConfig, type SnapshotManifest, storeSnapshot } from "./store.ts";

interface BackfillFile {
  package?: string;
  partial?: boolean;
  collectedAt: string;
  window: { start: string; end: string };
  lastDay: { day: string; downloads: number };
  latestVersion?: string | null;
  downloadsByVersion: Record<string, number>;
}

export async function runBackfill(kv: Deno.Kv, packages: PackageConfig[]): Promise<void> {
  for (const pkg of packages) {
    const path = `backfill/${pkg.name}.json`;
    let raw: string;
    try {
      raw = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue; // no baseline for this package
      throw error;
    }

    const data = JSON.parse(raw) as BackfillFile;
    const entries = Object.entries(data.downloadsByVersion);
    if (entries.length === 0) continue;
    const versionTotal = entries.reduce((sum, [, downloads]) => sum + downloads, 0);

    // Keep the seeded snapshot internally consistent: `total` equals the sum of
    // the versions we actually have. `historyStatus: "partial"` signals that the
    // per-version map is incomplete (see the file's `weekTotalDownloads` note).
    const manifest: Omit<SnapshotManifest, "chunkCount" | "checksum"> = {
      schemaVersion: 2,
      package: data.package ?? pkg.name,
      collectedAt: data.collectedAt,
      window: { kind: "rolling-last-week", start: data.window.start, end: data.window.end, exact: true },
      total: versionTotal,
      versionTotal,
      rangeTotal: versionTotal,
      integrity: { versionsMatchPoint: true, rangeMatchesPoint: true, windowsAlign: true },
      freshness: { status: "fresh", expectedEnd: data.window.end, lagDays: 0 },
      healthStatus: "healthy",
      historyStatus: data.partial ? "partial" : "complete",
      lastDay: data.lastDay,
      latestVersion: data.latestVersion ?? null,
      sourceLastModified: { versions: null, pointWeek: null, rangeWeek: null, pointDay: null },
      versionCount: entries.length,
    };

    const result = await storeSnapshot(kv, manifest, entries);
    console.info(`[backfill] ${manifest.package} @ ${manifest.window.end}: ${result}`);
  }
}
