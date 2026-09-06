import { serveDir } from "jsr:@std/http@1/file-server";
import config from "./config/packages.json" with { type: "json" };
import { collectAll } from "./deno/collector.ts";
import {
  ensurePackages,
  listDailyDownloads,
  listManifests,
  listPackages,
  loadVersions,
  type PackageConfig,
  type SnapshotAssessment,
} from "./deno/store.ts";

const kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH"));
await ensurePackages(kv, config.packages as PackageConfig[]);

// ─── BEGIN drop-in backfill (safe to remove: delete this block, deno/backfill.ts, and backfill/) ───
import { runBackfill } from "./deno/backfill.ts";
await runBackfill(kv, config.packages as PackageConfig[]);
// ─── END drop-in backfill ───

Deno.cron(
  "collect npm version downloads",
  "17 4 * * *",
  { backoffSchedule: [60_000, 5 * 60_000, 15 * 60_000] },
  async () => {
    const result = await collectAll(kv);
    if (result.packages.every((item) => item.status === "failed")) {
      throw new Error("Every npm package collection failed");
    }
  },
);

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  for (const [name, headerValue] of Object.entries(securityHeaders)) headers.set(name, headerValue);
  return new Response(JSON.stringify(value), { ...init, headers });
}

async function dashboardResponse(): Promise<Response> {
  const packages = await listPackages(kv);
  const dashboardPackages = await Promise.all(packages.map(async (item) => {
    const [manifests, dailyTotals] = await Promise.all([
      listManifests(kv, item.name),
      listDailyDownloads(kv, "daily", item.name),
    ]);
    const snapshots = await Promise.all(manifests.map(async (manifest) => {
      const downloadsByVersion = await loadVersions(kv, manifest);
      const assessment = await kv.get<SnapshotAssessment>([
        "assessment",
        item.name,
        manifest.window.end,
      ]);
      const quality = assessment.value;
      const latestRelease = manifest.latestVersion
        ? await kv.get<{ publishedAt: string }>(["release", item.name, manifest.latestVersion])
        : null;
      return {
        collectedAt: manifest.collectedAt,
        lastCheckedAt: quality?.collectedAt ?? manifest.collectedAt,
        window: manifest.window,
        status: "ok",
        total: manifest.total,
        versionTotal: manifest.versionTotal,
        rangeTotal: quality?.rangeTotal ?? manifest.rangeTotal ?? null,
        integrity: quality?.integrity ?? manifest.integrity ?? {
          versionsMatchPoint: (manifest as unknown as { totalsMatch?: boolean }).totalsMatch ?? false,
          rangeMatchesPoint: null,
          windowsAlign: null,
        },
        freshness: quality?.freshness ?? manifest.freshness ?? null,
        healthStatus: quality?.healthStatus ?? manifest.healthStatus ?? "legacy",
        historyStatus: quality?.historyStatus ?? manifest.historyStatus ??
          (dailyTotals.length ? "complete" : "partial"),
        sourceLastModified: quality?.sourceLastModified ?? manifest.sourceLastModified ?? null,
        lastDay: manifest.lastDay,
        downloadsByVersion,
        latestVersion: manifest.latestVersion,
        releases: manifest.latestVersion && latestRelease?.value?.publishedAt
          ? { [manifest.latestVersion]: latestRelease.value.publishedAt }
          : {},
      };
    }));
    return { ...item, snapshots, dailyTotals };
  }));
  const [globalDaily, globalStatus] = await Promise.all([
    listDailyDownloads(kv, "global-daily", null),
    kv.get(["global-status"]),
  ]);

  return json({
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    collectionSchedule: "Daily at 04:17 UTC",
    globalBaseline: { dailyTotals: globalDaily, status: globalStatus.value },
    caveats: [
      "npm reports version downloads only for the latest seven-day window; retained history begins with this service.",
      "Daily version values are rolling-window observations, not exact per-version daily downloads.",
      "Each snapshot reconciles version, point, and range totals; delayed or mismatched source data remains visible.",
      "Downloads exclude installs served only by private registries, mirrors, and offline caches.",
    ],
    packages: dashboardPackages,
  });
}

async function handleAdminCollect(request: Request): Promise<Response> {
  const expected = Deno.env.get("ADMIN_TOKEN");
  if (!expected) return json({ error: "Not found" }, { status: 404 });
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  try {
    return json(await collectAll(kv));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") {
    const [lastRun, globalStatus] = await Promise.all([
      kv.get(["status", "last-run"]),
      kv.get(["global-status"]),
    ]);
    return json({
      ok: true,
      packages: (await listPackages(kv)).length,
      lastRun: lastRun.value,
      globalStatus: globalStatus.value,
    });
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") return await dashboardResponse();
  if (url.pathname === "/api/admin/collect" && request.method === "POST") {
    return await handleAdminCollect(request);
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, { status: 404 });

  const response = await serveDir(request, { fsRoot: "docs", quiet: true });
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  if (
    url.pathname === "/" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css")
  ) headers.set("cache-control", "no-cache");
  else headers.set("cache-control", "public, max-age=3600");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
