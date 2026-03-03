import * as fs from "fs";
import * as path from "path";

// ────────────────────────── Interfaces ──────────────────────────

/** A single BC artifact version entry from the CDN index. */
export interface BcArtifactVersion {
  /** Full version string, e.g. "27.4.45366.46497". */
  version: string;
  /** ISO date string when this artifact was published. */
  creationTime: string;
  /** Major BC version number, e.g. 27. */
  major: number;
  /** Minor BC version number, e.g. 4. */
  minor: number;
  /** The artifact type: "sandbox" or "onprem". */
  type: BcArtifactType;
  /** The country/locale code, e.g. "us", "w1". */
  country: string;
  /** The full artifact download URL. */
  artifactUrl: string;
}

/** Supported artifact types. */
export type BcArtifactType = "sandbox" | "onprem";

// ────────────────────────── Constants ───────────────────────────

const CDN_BASE = "https://bcartifacts-exdbf9fwegejdqak.b02.azurefd.net";
const REQUEST_TIMEOUT_MS = 15_000;

/** Disk-cache TTL — 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;

// Node 18+ / VS Code 1.82+ exposes a global fetch that is
// proxy-aware (respects http.proxy, HTTP_PROXY, etc.).
// We declare the minimal type so TS doesn't complain with ES2020 lib.
declare const fetch: (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

// ────────────────────────── Service ────────────────────────────

/**
 * Queries the BC Artifacts CDN JSON indexes to discover available
 * Business Central versions — no Docker or PowerShell required.
 *
 * Performance features:
 *  - Uses global `fetch()` which is proxy-aware inside VS Code
 *  - In-memory cache (Map) per type/country
 *  - Disk cache in globalStorageUri so repeat opens are instant
 */
export class BcArtifactsService {
  /** In-memory cache of raw CDN JSON (type/country → entries). */
  private _memCache = new Map<string, { Version: string; CreationTime: string }[]>();

  /** Disk-cache directory (set via setStoragePath). */
  private _diskCacheDir: string | undefined;

  /**
   * Call once after construction to enable disk caching.
   * Pass `context.globalStorageUri.fsPath`.
   */
  setStoragePath(dir: string): void {
    this._diskCacheDir = path.join(dir, "artifact-cache");
    try {
      fs.mkdirSync(this._diskCacheDir, { recursive: true });
    } catch {
      // If the directory can't be created, disk caching is silently disabled
      this._diskCacheDir = undefined;
    }
  }

  // ── HTTP helper ─────────────────────────────────────────────

  /**
   * Fetch a CDN path using the global fetch() API.
   * This respects VS Code proxy settings (http.proxy, HTTP_PROXY)
   * and handles TLS correctly inside the extension host.
   */
  private async _fetch(urlPath: string): Promise<string> {
    const url = `${CDN_BASE}${urlPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "BCDockerManager-VSCode/1.0" },
      });
      if (!res.ok) {
        throw new Error(`CDN returned HTTP ${res.status} ${res.statusText} for ${urlPath}`);
      }
      return await res.text();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`BC artifacts CDN request timed out (${REQUEST_TIMEOUT_MS}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Disk cache ──────────────────────────────────────────────

  private _diskCachePath(key: string): string | undefined {
    if (!this._diskCacheDir) { return undefined; }
    return path.join(this._diskCacheDir, key.replace("/", "_") + ".json");
  }

  private _readDiskCache(key: string): { Version: string; CreationTime: string }[] | undefined {
    const fp = this._diskCachePath(key);
    if (!fp) { return undefined; }
    try {
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) { return undefined; }
      return JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      return undefined;
    }
  }

  private _writeDiskCache(key: string, data: unknown): void {
    const fp = this._diskCachePath(key);
    if (!fp) { return; }
    try { fs.writeFileSync(fp, JSON.stringify(data)); } catch { /* best-effort */ }
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Get the list of available country codes for a given artifact type.
   */
  async getCountries(type: BcArtifactType): Promise<string[]> {
    const cacheKey = `${type}/countries`;

    // 1. Memory
    const mem = this._memCache.get(cacheKey);
    if (mem) { return (mem as unknown as string[]).slice().sort(); }

    // 2. Disk
    const disk = this._readDiskCache(cacheKey);
    if (disk) {
      this._memCache.set(cacheKey, disk);
      return (disk as unknown as string[]).slice().sort();
    }

    // 3. Network
    const body = await this._fetch(`/${type}/indexes/countries.json`);
    const countries = JSON.parse(body) as string[];
    this._memCache.set(cacheKey, countries as unknown as { Version: string; CreationTime: string }[]);
    this._writeDiskCache(cacheKey, countries);
    return countries.slice().sort();
  }

  /**
   * Get all available BC versions for a type + country.
   * Returns versions sorted newest-first.
   */
  async getVersions(type: BcArtifactType, country: string): Promise<BcArtifactVersion[]> {
    return this._parseVersions(type, country, await this._getRawIndex(type, country));
  }

  /**
   * Get only the N newest versions for a type + country.
   */
  async getLatestVersions(
    type: BcArtifactType,
    country: string,
    limit: number,
  ): Promise<{ versions: BcArtifactVersion[]; totalCount: number }> {
    const raw = await this._getRawIndex(type, country);
    const totalCount = raw.length;
    const tail = raw.slice(Math.max(0, raw.length - limit));
    const versions = this._parseVersions(type, country, tail);
    return { versions, totalCount };
  }

  /**
   * Fetch + cache the raw JSON index (memory → disk → network).
   */
  private async _getRawIndex(
    type: BcArtifactType,
    country: string,
  ): Promise<{ Version: string; CreationTime: string }[]> {
    const key = `${type}/${country}`;

    const mem = this._memCache.get(key);
    if (mem) { return mem; }

    const disk = this._readDiskCache(key);
    if (disk) {
      this._memCache.set(key, disk);
      return disk;
    }

    const body = await this._fetch(`/${type}/indexes/${country}.json`);
    const data = JSON.parse(body) as { Version: string; CreationTime: string }[];
    this._memCache.set(key, data);
    this._writeDiskCache(key, data);
    return data;
  }

  /** Parse raw CDN entries into BcArtifactVersion[], sorted newest-first. */
  private _parseVersions(
    type: BcArtifactType,
    country: string,
    raw: { Version: string; CreationTime: string }[],
  ): BcArtifactVersion[] {
    const versions: BcArtifactVersion[] = raw.map((entry) => {
      const parts = entry.Version.split(".");
      return {
        version: entry.Version,
        creationTime: entry.CreationTime,
        major: parseInt(parts[0], 10) || 0,
        minor: parseInt(parts[1], 10) || 0,
        type,
        country,
        artifactUrl: `https://bcartifacts-exdbf9fwegejdqak.b02.azurefd.net/${type}/${entry.Version}/${country}`,
      };
    });

    versions.sort((a, b) => {
      if (a.major !== b.major) { return b.major - a.major; }
      if (a.minor !== b.minor) { return b.minor - a.minor; }
      return b.version.localeCompare(a.version, undefined, { numeric: true });
    });

    return versions;
  }

  /**
   * Get versions grouped by major BC version.
   */
  async getVersionsGroupedByMajor(
    type: BcArtifactType,
    country: string,
  ): Promise<Map<number, BcArtifactVersion[]>> {
    const versions = await this.getVersions(type, country);
    const grouped = new Map<number, BcArtifactVersion[]>();
    for (const v of versions) {
      if (!grouped.has(v.major)) { grouped.set(v.major, []); }
      grouped.get(v.major)!.push(v);
    }
    return grouped;
  }

  /**
   * Get only the latest version per major release for a country.
   */
  async getLatestPerMajor(
    type: BcArtifactType,
    country: string,
  ): Promise<BcArtifactVersion[]> {
    const grouped = await this.getVersionsGroupedByMajor(type, country);
    const result: BcArtifactVersion[] = [];
    for (const [, versions] of grouped) {
      if (versions.length > 0) { result.push(versions[0]); }
    }
    result.sort((a, b) => b.major - a.major);
    return result;
  }

  /** Quick connectivity test — returns milliseconds or error message. */
  async testConnection(): Promise<string> {
    const t0 = Date.now();
    try {
      const body = await this._fetch("/sandbox/indexes/countries.json");
      const ms = Date.now() - t0;
      const countries = JSON.parse(body) as string[];
      return `OK — ${countries.length} countries in ${ms}ms`;
    } catch (err) {
      const ms = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      return `FAILED after ${ms}ms — ${msg}`;
    }
  }

  /** Quick connectivity test (boolean). */
  async isReachable(): Promise<boolean> {
    try {
      await this._fetch("/sandbox/indexes/countries.json");
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    // No agent to destroy with fetch()
  }
}
