import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboard, encodePackageName, normalizeVersionDownloads, releaseMetadata } from "../scripts/lib.mjs";

test("encodes scoped package names as one URL segment", () => {
  assert.equal(encodePackageName("@scope/package"), "%40scope%2Fpackage");
});

test("normalizes and totals version downloads", () => {
  assert.deepEqual(normalizeVersionDownloads({ downloads: { "2.0.0": 7, "1.0.0": 3, bad: -1 } }), {
    downloadsByVersion: { "1.0.0": 3, "2.0.0": 7 },
    total: 10,
  });
});

test("keeps release dates only for observed versions", () => {
  assert.deepEqual(releaseMetadata({ "dist-tags": { latest: "2.0.0" }, time: { "1.0.0": "2025-01-01", "2.0.0": "2025-02-01", "3.0.0": "2025-03-01" } }, ["1.0.0", "2.0.0"]), {
    latestVersion: "2.0.0",
    releases: { "1.0.0": "2025-01-01", "2.0.0": "2025-02-01" },
  });
});

test("aggregates successful and failed package snapshots without dropping either", () => {
  const dashboard = buildDashboard(
    [{ name: "one", label: "One" }, { name: "two", label: "Two" }],
    [{
      collectedAt: "2026-01-01T00:00:00Z",
      window: { kind: "rolling-last-week" },
      packages: [
        { name: "one", status: "ok", total: 8, downloadsByVersion: { "1.0.0": 8 }, latestVersion: "1.0.0", releases: {} },
        { name: "two", status: "failed", error: "503" },
      ],
    }],
  );
  assert.equal(dashboard.packages[0].snapshots[0].total, 8);
  assert.equal(dashboard.packages[1].snapshots[0].status, "failed");
  assert.equal(dashboard.packages[1].snapshots[0].error, "503");
});
