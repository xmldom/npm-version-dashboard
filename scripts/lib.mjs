import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ROOT = new URL("../", import.meta.url).pathname;

export function encodePackageName(name) {
  return encodeURIComponent(name);
}

export async function fetchJson(url, { fetchImpl = fetch, attempts = 3, timeoutMs = 30_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          "user-agent": "npm-version-dashboard/0.1 (+https://github.com/PaulKinlan/npm-version-dashboard)",
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export function normalizeVersionDownloads(payload) {
  const downloadsByVersion = Object.fromEntries(
    Object.entries(payload.downloads ?? {})
      .filter(([, value]) => Number.isFinite(value) && value >= 0)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })),
  );
  return {
    downloadsByVersion,
    total: Object.values(downloadsByVersion).reduce((sum, value) => sum + value, 0),
  };
}

export function releaseMetadata(registryPayload, downloadedVersions) {
  const times = registryPayload.time ?? {};
  const releases = {};
  for (const version of downloadedVersions) {
    if (times[version]) releases[version] = times[version];
  }
  return {
    latestVersion: registryPayload["dist-tags"]?.latest ?? null,
    releases,
  };
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temp, path);
}

export async function readConfig(root = ROOT) {
  const value = JSON.parse(await readFile(join(root, "config/packages.json"), "utf8"));
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    throw new Error("config/packages.json must contain packages");
  }
  const names = new Set();
  for (const item of value.packages) {
    if (!item.name || names.has(item.name)) {
      throw new Error(`Invalid or duplicate package: ${item.name ?? "<missing>"}`);
    }
    names.add(item.name);
  }
  return value.packages;
}

export async function loadSnapshots(root = ROOT) {
  const directory = join(root, "data/snapshots");
  let files = [];
  try {
    files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))));
}

export function buildDashboard(packages, snapshots) {
  const series = new Map(packages.map((item) => [item.name, { ...item, snapshots: [] }]));
  for (const snapshot of snapshots.sort((a, b) => a.collectedAt.localeCompare(b.collectedAt))) {
    for (const item of snapshot.packages ?? []) {
      const target = series.get(item.name);
      if (!target) continue;
      target.snapshots.push({
        collectedAt: snapshot.collectedAt,
        window: snapshot.window,
        status: item.status,
        total: item.total ?? null,
        downloadsByVersion: item.downloadsByVersion ?? {},
        latestVersion: item.latestVersion ?? null,
        releases: item.releases ?? {},
        error: item.error ?? null,
      });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: snapshots.at(-1)?.collectedAt ?? null,
    caveats: [
      "npm exposes per-version downloads only for a rolling last-week window; history begins with this collector.",
      "Weekly snapshots can be affected by npm reporting lag and should not be interpreted as exact calendar weeks.",
      "Downloads exclude installs served only by private registries, mirrors, and offline caches.",
    ],
    packages: [...series.values()],
  };
}

export async function writeDashboard(root = ROOT) {
  const packages = await readConfig(root);
  const snapshots = await loadSnapshots(root);
  const dashboard = buildDashboard(packages, snapshots);
  const dataPath = join(root, "data/dashboard.json");
  const docsPath = join(root, "docs/data/dashboard.json");
  await atomicWriteJson(dataPath, dashboard);
  await mkdir(dirname(docsPath), { recursive: true });
  await copyFile(dataPath, docsPath);
  return dashboard;
}
