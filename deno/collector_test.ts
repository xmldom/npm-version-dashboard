import { assertEquals } from "jsr:@std/assert@1";
import { assessSnapshot } from "./collector.ts";

const healthy = {
  pointStart: "2026-07-13",
  pointEnd: "2026-07-19",
  pointTotal: 100,
  rangeStart: "2026-07-13",
  rangeEnd: "2026-07-19",
  rangeTotal: 100,
  versionTotal: 100,
  dayEnd: "2026-07-19",
  collectedAt: "2026-07-20T12:00:00Z",
};

Deno.test("snapshot assessment recognizes aligned and reconciled data", () => {
  assertEquals(assessSnapshot(healthy), {
    integrity: { versionsMatchPoint: true, rangeMatchesPoint: true, windowsAlign: true },
    freshness: { status: "fresh", expectedEnd: "2026-07-19", lagDays: 0 },
    healthStatus: "healthy",
  });
});

Deno.test("snapshot assessment prioritizes mismatches over freshness", () => {
  const result = assessSnapshot({
    ...healthy,
    pointEnd: "2026-07-16",
    rangeEnd: "2026-07-16",
    dayEnd: "2026-07-16",
    versionTotal: 99,
  });
  assertEquals(result.freshness.status, "delayed");
  assertEquals(result.integrity.versionsMatchPoint, false);
  assertEquals(result.healthStatus, "mismatch");
});

Deno.test("snapshot assessment distinguishes delayed but internally consistent data", () => {
  const result = assessSnapshot({
    ...healthy,
    pointEnd: "2026-07-16",
    rangeEnd: "2026-07-16",
    dayEnd: "2026-07-16",
  });
  assertEquals(result.healthStatus, "delayed");
  assertEquals(result.freshness.lagDays, 3);
});
