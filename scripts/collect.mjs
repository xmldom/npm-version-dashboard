import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  ROOT,
  atomicWriteJson,
  encodePackageName,
  fetchJson,
  normalizeVersionDownloads,
  readConfig,
  releaseMetadata,
  writeDashboard,
} from "./lib.mjs";

const packages = await readConfig();
const collectedAt = new Date().toISOString();
const snapshotDate = collectedAt.slice(0, 10);
const snapshotPath = join(ROOT, "data/snapshots", `${snapshotDate}.json`);

try {
  await access(snapshotPath);
  console.log(`Snapshot already exists: ${snapshotPath}`);
  await writeDashboard();
  process.exit(0);
} catch {
  // Expected for a new collection date.
}

const results = await Promise.all(packages.map(async (configuredPackage) => {
  const encoded = encodePackageName(configuredPackage.name);
  const versionsUrl = `https://api.npmjs.org/versions/${encoded}/last-week`;
  const registryUrl = `https://registry.npmjs.org/${encoded}`;
  try {
    const [versionPayload, registryPayload] = await Promise.all([
      fetchJson(versionsUrl),
      fetchJson(registryUrl),
    ]);
    const normalized = normalizeVersionDownloads(versionPayload);
    const metadata = releaseMetadata(registryPayload, Object.keys(normalized.downloadsByVersion));
    return {
      name: configuredPackage.name,
      status: "ok",
      source: versionsUrl,
      ...normalized,
      ...metadata,
    };
  } catch (error) {
    return {
      name: configuredPackage.name,
      status: "failed",
      source: versionsUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}));

const snapshot = {
  schemaVersion: 1,
  collectedAt,
  window: {
    kind: "rolling-last-week",
    sourceLabel: "last-week",
    exactStartAndEndUnavailable: true
  },
  packages: results,
};

await atomicWriteJson(snapshotPath, snapshot);
await writeDashboard();

const succeeded = results.filter((item) => item.status === "ok").length;
const failed = results.length - succeeded;
console.log(`Collected ${succeeded}/${results.length} packages; ${failed} failed; wrote ${snapshotPath}`);
if (succeeded === 0) process.exitCode = 1;
