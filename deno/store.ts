export interface PackageConfig {
  name: string;
  label?: string;
  group?: string;
  important?: boolean;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  package: string;
  collectedAt: string;
  window: { kind: "rolling-last-week"; start: string; end: string; exact: true };
  total: number;
  versionTotal: number;
  totalsMatch: boolean;
  lastDay: { day: string; downloads: number };
  latestVersion: string | null;
  chunkCount: number;
  versionCount: number;
  checksum: string;
}

export interface SnapshotChunk {
  versions: Record<string, number>;
}

export interface CollectionFailure {
  package: string;
  collectedAt: string;
  error: string;
}

const encoder = new TextEncoder();

export async function sha256(value: unknown): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function chunkVersions(entries: Array<[string, number]>, maxBytes = 48_000): SnapshotChunk[] {
  const chunks: SnapshotChunk[] = [];
  let versions: Record<string, number> = {};
  let size = 16;
  for (const [version, downloads] of entries) {
    const added = encoder.encode(JSON.stringify([version, downloads])).byteLength + 2;
    if (size + added > maxBytes && Object.keys(versions).length > 0) {
      chunks.push({ versions });
      versions = {};
      size = 16;
    }
    versions[version] = downloads;
    size += added;
  }
  if (Object.keys(versions).length > 0 || chunks.length === 0) chunks.push({ versions });
  return chunks;
}

export async function storeSnapshot(
  kv: Deno.Kv,
  manifest: Omit<SnapshotManifest, "chunkCount" | "checksum">,
  entries: Array<[string, number]>,
): Promise<"created" | "existing"> {
  const manifestKey: Deno.KvKey = ["snapshot", manifest.package, manifest.window.end];
  const existing = await kv.get<SnapshotManifest>(manifestKey);
  if (existing.value) return "existing";

  const chunks = chunkVersions(entries);
  const checksum = await sha256(entries);
  await Promise.all(
    chunks.map((chunk, index) =>
      kv.set(["snapshot-chunk", manifest.package, manifest.window.end, index], chunk)
    ),
  );

  const complete: SnapshotManifest = { ...manifest, chunkCount: chunks.length, checksum };
  const result = await kv.atomic().check(existing).set(manifestKey, complete).commit();
  return result.ok ? "created" : "existing";
}

export async function loadVersions(kv: Deno.Kv, manifest: SnapshotManifest): Promise<Record<string, number>> {
  const chunks = await Promise.all(
    Array.from(
      { length: manifest.chunkCount },
      (_, index) => kv.get<SnapshotChunk>(["snapshot-chunk", manifest.package, manifest.window.end, index]),
    ),
  );
  const versions = Object.assign({}, ...chunks.map((entry) => entry.value?.versions ?? {}));
  const checksum = await sha256(Object.entries(versions));
  if (checksum !== manifest.checksum) {
    throw new Error(`Snapshot checksum mismatch: ${manifest.package}/${manifest.window.end}`);
  }
  return versions;
}

export async function listManifests(
  kv: Deno.Kv,
  packageName: string,
  limit = 366,
): Promise<SnapshotManifest[]> {
  const manifests: SnapshotManifest[] = [];
  for await (
    const entry of kv.list<SnapshotManifest>({ prefix: ["snapshot", packageName] }, { reverse: true, limit })
  ) {
    manifests.push(entry.value);
  }
  return manifests.reverse();
}

export async function ensurePackages(kv: Deno.Kv, packages: PackageConfig[]): Promise<void> {
  await Promise.all(packages.map((item) => kv.set(["package", item.name], item)));
}

export async function listPackages(kv: Deno.Kv): Promise<PackageConfig[]> {
  const packages: PackageConfig[] = [];
  for await (const entry of kv.list<PackageConfig>({ prefix: ["package"] })) packages.push(entry.value);
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}
