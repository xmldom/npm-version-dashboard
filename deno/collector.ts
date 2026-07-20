import type { CollectionFailure, DailyDownload, PackageConfig } from "./store.ts";
import { listPackages, storeDailyDownloads, storeSnapshot } from "./store.ts";

interface VersionResponse {
  package: string;
  downloads: Record<string, number>;
}

interface PointResponse {
  downloads: number;
  start: string;
  end: string;
  package?: string;
}

interface RangeResponse {
  downloads: DailyDownload[];
  start: string;
  end: string;
  package?: string;
}

interface LatestMetadata {
  version?: string;
}

interface Packument {
  time?: Record<string, string>;
}

interface RegistryMetadata {
  latestVersion: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

interface FetchResult<T> {
  data: T;
  lastModified: string | null;
}

interface Timed<T> {
  data: T;
  lastModified: string | null;
}

type PackageFetchResult<T> = Timed<T> | { error: string };

export interface CollectionResult {
  startedAt: string;
  finishedAt: string;
  globalBaseline: "ok" | "failed";
  packages: Array<{ name: string; status: "created" | "existing" | "failed"; error?: string }>;
}

const API = "https://api.npmjs.org";
const REGISTRY = "https://registry.npmjs.org";
const EARLIEST_NPM_DAY = "2015-01-10";

function encodePackageName(name: string): string {
  return encodeURIComponent(name);
}

async function fetchJson<T>(url: string, attempts = 3, timeoutMs = 30_000): Promise<FetchResult<T>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "npm-version-dashboard/0.3" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        if (response.status < 500 && response.status !== 429) throw Object.assign(error, { permanent: true });
        throw error;
      }
      return {
        data: await response.json() as T,
        lastModified: response.headers.get("last-modified"),
      };
    } catch (error) {
      lastError = error;
      if ((error as { permanent?: boolean }).permanent || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(earlier: string, later: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000),
  );
}

function minimumDay(a: string, b: string): string {
  return a < b ? a : b;
}

function expectedLatestDay(now: string): string {
  return addDays(now.slice(0, 10), -1);
}

export function assessSnapshot(input: {
  pointStart: string;
  pointEnd: string;
  pointTotal: number;
  rangeStart: string;
  rangeEnd: string;
  rangeTotal: number;
  versionTotal: number;
  dayEnd: string;
  collectedAt: string;
}) {
  const integrity = {
    versionsMatchPoint: input.versionTotal === input.pointTotal,
    rangeMatchesPoint: input.rangeTotal === input.pointTotal,
    windowsAlign: input.pointStart === input.rangeStart && input.pointEnd === input.rangeEnd &&
      input.dayEnd === input.pointEnd,
  };
  const expectedEnd = expectedLatestDay(input.collectedAt);
  const lagDays = daysBetween(input.pointEnd, expectedEnd);
  const freshness = { status: lagDays > 1 ? "delayed" as const : "fresh" as const, expectedEnd, lagDays };
  const healthStatus =
    !integrity.versionsMatchPoint || !integrity.rangeMatchesPoint || !integrity.windowsAlign
      ? "mismatch" as const
      : freshness.status === "delayed"
      ? "delayed" as const
      : "healthy" as const;
  return { integrity, freshness, healthStatus };
}

async function fetchPackageData<T extends PointResponse | RangeResponse>(
  packages: PackageConfig[],
  family: "point" | "range",
  period: string,
): Promise<Map<string, PackageFetchResult<T>>> {
  const results = new Map<string, PackageFetchResult<T>>();
  const unscoped = packages.filter((item) => !item.name.startsWith("@"));
  const scoped = packages.filter((item) => item.name.startsWith("@"));

  async function fetchOne(item: PackageConfig): Promise<void> {
    try {
      const result = await fetchJson<T>(
        `${API}/downloads/${family}/${period}/${encodePackageName(item.name)}`,
      );
      results.set(item.name, result);
    } catch (error) {
      results.set(item.name, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (let index = 0; index < unscoped.length; index += 128) {
    const chunk = unscoped.slice(index, index + 128);
    if (chunk.length === 1) {
      await fetchOne(chunk[0]);
      continue;
    }
    try {
      const response = await fetchJson<Record<string, T>>(
        `${API}/downloads/${family}/${period}/${chunk.map((item) => item.name).join(",")}`,
      );
      for (const item of chunk) {
        const data = response.data[item.name];
        if (!data) throw new Error(`Bulk ${family} response omitted ${item.name}`);
        results.set(item.name, { data, lastModified: response.lastModified });
      }
    } catch {
      // A bulk-provider failure must not merge package failure domains.
      for (const item of chunk) await fetchOne(item);
    }
  }
  for (const item of scoped) await fetchOne(item);
  return results;
}

async function refreshRegistryMetadata(
  kv: Deno.Kv,
  packageName: string,
  observedVersions: string[],
): Promise<RegistryMetadata> {
  const encoded = encodePackageName(packageName);
  const latest = await fetchJson<LatestMetadata>(`${REGISTRY}/${encoded}/latest`);
  const latestVersion = latest.data.version ?? null;
  const existing = await kv.get<RegistryMetadata>(["registry-meta", packageName]);
  const missing: string[] = [];
  for (const version of new Set([...observedVersions, ...(latestVersion ? [latestVersion] : [])])) {
    if (!(await kv.get(["release", packageName, version])).value) missing.push(version);
  }
  if (existing.value?.latestVersion === latestVersion && missing.length === 0) return existing.value;

  const packument = await fetchJson<Packument>(`${REGISTRY}/${encoded}`);
  for (let index = 0; index < missing.length; index += 10) {
    let atomic = kv.atomic();
    for (const version of missing.slice(index, index + 10)) {
      const publishedAt = packument.data.time?.[version];
      if (publishedAt) atomic = atomic.set(["release", packageName, version], { version, publishedAt });
    }
    const result = await atomic.commit();
    if (!result.ok) throw new Error(`Could not store release metadata for ${packageName}`);
  }
  const metadata: RegistryMetadata = {
    latestVersion,
    createdAt: packument.data.time?.created ?? existing.value?.createdAt ?? null,
    modifiedAt: packument.data.time?.modified ?? existing.value?.modifiedAt ?? null,
  };
  await kv.set(["registry-meta", packageName], metadata);
  return metadata;
}

async function backfillDailyHistory(
  kv: Deno.Kv,
  packageName: string | null,
  requestedStart: string,
  targetEnd: string,
): Promise<void> {
  const stateKey: Deno.KvKey = packageName ? ["backfill", packageName] : ["backfill-global"];
  const state = await kv.get<{ through: string }>(stateKey);
  let cursor = state.value?.through ? addDays(state.value.through, 1) : requestedStart;
  if (cursor > targetEnd) return;

  while (cursor <= targetEnd) {
    const end = minimumDay(addDays(cursor, 364), targetEnd);
    const suffix = packageName ? `/${encodePackageName(packageName)}` : "";
    const response = await fetchJson<RangeResponse>(`${API}/downloads/range/${cursor}:${end}${suffix}`);
    await storeDailyDownloads(
      kv,
      packageName ? "daily" : "global-daily",
      packageName,
      response.data.downloads,
    );
    await kv.set(stateKey, {
      through: response.data.end,
      lastModified: response.lastModified,
      updatedAt: new Date().toISOString(),
    });
    cursor = addDays(response.data.end, 1);
  }
}

async function collectGlobalBaseline(kv: Deno.Kv, collectedAt: string): Promise<void> {
  const [week, day] = await Promise.all([
    fetchJson<RangeResponse>(`${API}/downloads/range/last-week`),
    fetchJson<PointResponse>(`${API}/downloads/point/last-day`),
  ]);
  await storeDailyDownloads(kv, "global-daily", null, week.data.downloads);
  let historyStatus: "complete" | "partial" = "complete";
  try {
    await backfillDailyHistory(kv, null, EARLIEST_NPM_DAY, day.data.end);
  } catch (error) {
    historyStatus = "partial";
    await kv.set(["global-backfill-failure", collectedAt], {
      collectedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await kv.set(["global-status"], {
    collectedAt,
    window: { start: week.data.start, end: week.data.end },
    lastDay: { day: day.data.end, downloads: day.data.downloads },
    lastModified: { range: week.lastModified, point: day.lastModified },
    windowsAlign: week.data.end === day.data.end,
    historyStatus,
  });
}

async function collectPackage(
  kv: Deno.Kv,
  item: PackageConfig,
  collectedAt: string,
  week: Timed<PointResponse>,
  day: Timed<PointResponse>,
  range: Timed<RangeResponse>,
) {
  const encoded = encodePackageName(item.name);
  const versionsPayload = await fetchJson<VersionResponse>(`${API}/versions/${encoded}/last-week`);
  const entries = Object.entries(versionsPayload.data.downloads ?? {})
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] >= 0)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const versionTotal = entries.reduce((sum, [, downloads]) => sum + downloads, 0);
  const rangeTotal = range.data.downloads.reduce((sum, point) => sum + point.downloads, 0);
  const metadata = await refreshRegistryMetadata(kv, item.name, entries.map(([version]) => version));

  await storeDailyDownloads(kv, "daily", item.name, range.data.downloads);
  const createdDay = metadata.createdAt?.slice(0, 10) ?? EARLIEST_NPM_DAY;
  let historyStatus: "complete" | "partial" = "complete";
  try {
    await backfillDailyHistory(
      kv,
      item.name,
      createdDay < EARLIEST_NPM_DAY ? EARLIEST_NPM_DAY : createdDay,
      day.data.end,
    );
  } catch (error) {
    historyStatus = "partial";
    await kv.set(["backfill-failure", item.name, collectedAt], {
      package: item.name,
      collectedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const assessment = assessSnapshot({
    pointStart: week.data.start,
    pointEnd: week.data.end,
    pointTotal: week.data.downloads,
    rangeStart: range.data.start,
    rangeEnd: range.data.end,
    rangeTotal,
    versionTotal,
    dayEnd: day.data.end,
    collectedAt,
  });

  const sourceLastModified = {
    versions: versionsPayload.lastModified,
    pointWeek: week.lastModified,
    rangeWeek: range.lastModified,
    pointDay: day.lastModified,
  };
  const status = await storeSnapshot(kv, {
    schemaVersion: 2,
    package: item.name,
    collectedAt,
    window: { kind: "rolling-last-week", start: week.data.start, end: week.data.end, exact: true },
    total: week.data.downloads,
    versionTotal,
    rangeTotal,
    integrity: assessment.integrity,
    freshness: assessment.freshness,
    healthStatus: assessment.healthStatus,
    historyStatus,
    lastDay: { day: day.data.end, downloads: day.data.downloads },
    latestVersion: metadata.latestVersion,
    sourceLastModified,
    versionCount: entries.length,
  }, entries);
  await kv.set(["assessment", item.name, week.data.end], {
    collectedAt,
    rangeTotal,
    integrity: assessment.integrity,
    freshness: assessment.freshness,
    healthStatus: assessment.healthStatus,
    historyStatus,
    sourceLastModified,
  });
  return status;
}

export async function collectAll(kv: Deno.Kv): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const lockKey: Deno.KvKey = ["locks", "daily-collection"];
  const lock = await kv.get(lockKey);
  const acquired = await kv.atomic().check(lock).set(lockKey, { startedAt }, { expireIn: 20 * 60 * 1000 })
    .commit();
  if (!acquired.ok) throw new Error("A collection is already running");

  const results: CollectionResult["packages"] = [];
  let globalBaseline: CollectionResult["globalBaseline"] = "ok";
  try {
    const packages = await listPackages(kv);
    try {
      await collectGlobalBaseline(kv, startedAt);
    } catch (error) {
      globalBaseline = "failed";
      await kv.set(["global-failure", startedAt], {
        collectedAt: startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const [weeks, days, ranges] = await Promise.all([
      fetchPackageData<PointResponse>(packages, "point", "last-week"),
      fetchPackageData<PointResponse>(packages, "point", "last-day"),
      fetchPackageData<RangeResponse>(packages, "range", "last-week"),
    ]);

    for (const item of packages) {
      try {
        const week = weeks.get(item.name);
        const day = days.get(item.name);
        const range = ranges.get(item.name);
        if (!week || !day || !range) throw new Error(`Missing prefetched npm data for ${item.name}`);
        if ("error" in week || "error" in day || "error" in range) {
          throw new Error(
            [week, day, range].flatMap((value) => value && "error" in value ? [value.error] : []).join("; "),
          );
        }
        const status = await collectPackage(kv, item, startedAt, week, day, range);
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
    const result = { startedAt, finishedAt, globalBaseline, packages: results };
    await kv.set(["runs", finishedAt], result);
    await kv.set(["status", "last-run"], result);
    return result;
  } finally {
    await kv.delete(lockKey);
  }
}
