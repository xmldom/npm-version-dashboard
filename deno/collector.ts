import type { CollectionFailure, PackageConfig } from "./store.ts";
import { listPackages, storeSnapshot } from "./store.ts";

interface VersionResponse {
  package: string;
  downloads: Record<string, number>;
}

interface PointResponse {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

interface LatestMetadata {
  version?: string;
}

interface Packument {
  time?: Record<string, string>;
}

export interface CollectionResult {
  startedAt: string;
  finishedAt: string;
  packages: Array<{ name: string; status: "created" | "existing" | "failed"; error?: string }>;
}

function encodePackageName(name: string): string {
  return encodeURIComponent(name);
}

async function fetchJson<T>(url: string, attempts = 3, timeoutMs = 30_000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "npm-version-dashboard/0.2" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function updateReleaseMetadata(
  kv: Deno.Kv,
  packageName: string,
  encoded: string,
  latestVersion: string | null,
  observedVersions: string[],
): Promise<void> {
  const missing: string[] = [];
  for (const version of new Set([...observedVersions, ...(latestVersion ? [latestVersion] : [])])) {
    if (!(await kv.get(["release", packageName, version])).value) missing.push(version);
  }
  if (missing.length === 0) return;
  const packument = await fetchJson<Packument>(`https://registry.npmjs.org/${encoded}`);
  await Promise.all(missing.map((version) => {
    const publishedAt = packument.time?.[version];
    return publishedAt
      ? kv.set(["release", packageName, version], { version, publishedAt })
      : Promise.resolve();
  }));
}

async function collectPackage(kv: Deno.Kv, item: PackageConfig, collectedAt: string) {
  const encoded = encodePackageName(item.name);
  const [versionsPayload, week, day, latest] = await Promise.all([
    fetchJson<VersionResponse>(`https://api.npmjs.org/versions/${encoded}/last-week`),
    fetchJson<PointResponse>(`https://api.npmjs.org/downloads/point/last-week/${encoded}`),
    fetchJson<PointResponse>(`https://api.npmjs.org/downloads/point/last-day/${encoded}`),
    fetchJson<LatestMetadata>(`https://registry.npmjs.org/${encoded}/latest`),
  ]);

  const entries = Object.entries(versionsPayload.downloads ?? {})
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] >= 0)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const versionTotal = entries.reduce((sum, [, downloads]) => sum + downloads, 0);
  const latestVersion = latest.version ?? null;

  await updateReleaseMetadata(kv, item.name, encoded, latestVersion, entries.map(([version]) => version));
  return await storeSnapshot(kv, {
    schemaVersion: 1,
    package: item.name,
    collectedAt,
    window: { kind: "rolling-last-week", start: week.start, end: week.end, exact: true },
    total: week.downloads,
    versionTotal,
    totalsMatch: week.downloads === versionTotal,
    lastDay: { day: day.end, downloads: day.downloads },
    latestVersion,
    versionCount: entries.length,
  }, entries);
}

export async function collectAll(kv: Deno.Kv): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const lockKey: Deno.KvKey = ["locks", "daily-collection"];
  const lock = await kv.get(lockKey);
  const acquired = await kv.atomic().check(lock).set(lockKey, { startedAt }, { expireIn: 20 * 60 * 1000 })
    .commit();
  if (!acquired.ok) throw new Error("A collection is already running");

  const results: CollectionResult["packages"] = [];
  try {
    const packages = await listPackages(kv);
    for (const item of packages) {
      try {
        const status = await collectPackage(kv, item, startedAt);
        results.push({ name: item.name, status });
      } catch (error) {
        const failure: CollectionFailure = {
          package: item.name,
          collectedAt: startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
        await kv.set(["failure", item.name, startedAt], failure);
        results.push({ name: item.name, status: "failed", error: failure.error });
      }
    }
    const finishedAt = new Date().toISOString();
    const result = { startedAt, finishedAt, packages: results };
    await kv.set(["runs", finishedAt], result);
    await kv.set(["status", "last-run"], result);
    return result;
  } finally {
    await kv.delete(lockKey);
  }
}
