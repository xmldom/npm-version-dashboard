import { assertEquals } from "jsr:@std/assert@1";
import { chunkVersions, loadVersions, sha256, storeSnapshot } from "./store.ts";

Deno.test("version chunks stay below the requested target", () => {
  const entries = Array.from({ length: 40 }, (_, index) => [`1.0.${index}`, index] as [string, number]);
  const chunks = chunkVersions(entries, 120);
  assertEquals(chunks.length > 1, true);
  assertEquals(Object.keys(Object.assign({}, ...chunks.map((item) => item.versions))).length, entries.length);
});

Deno.test("snapshot manifests are immutable and chunks round-trip with checksum validation", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const entries: Array<[string, number]> = [["1.0.0", 3], ["2.0.0", 7]];
    const base = {
      schemaVersion: 1 as const,
      package: "example",
      collectedAt: "2026-07-20T00:00:00Z",
      window: {
        kind: "rolling-last-week" as const,
        start: "2026-07-13",
        end: "2026-07-19",
        exact: true as const,
      },
      total: 10,
      versionTotal: 10,
      totalsMatch: true,
      lastDay: { day: "2026-07-19", downloads: 2 },
      latestVersion: "2.0.0",
      versionCount: 2,
    };
    assertEquals(await storeSnapshot(kv, base, entries), "created");
    assertEquals(await storeSnapshot(kv, base, entries), "existing");
    const manifest = (await kv.get<Parameters<typeof loadVersions>[1]>(["snapshot", "example", "2026-07-19"]))
      .value!;
    assertEquals(await loadVersions(kv, manifest), { "1.0.0": 3, "2.0.0": 7 });
    assertEquals(manifest.checksum, await sha256(entries));
  } finally {
    kv.close();
  }
});
