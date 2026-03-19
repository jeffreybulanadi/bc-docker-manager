import * as fs from "fs";
import * as fsp from "fs/promises";
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

  /** Cache of parsed+sorted versions to avoid re-parsing on every call. */
  private _parsedCache = new Map<string, BcArtifactVersion[]>();

  /** Disk-cache directory (set via setStoragePath). */
  private _diskCacheDir: string | undefined;

  /** Pending disk-write promises (for test flushing). */
  private _pendingWrites: Promise<void>[] = [];

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
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 500ms, 1500ms
        await new Promise((r) => setTimeout(r, 500 * Math.pow(3, attempt - 1)));
      }

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
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          lastErr = new Error(`BC artifacts CDN request timed out (${REQUEST_TIMEOUT_MS}ms)`);
        } else {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
        // Retry on network errors and timeouts; don't retry 4xx client errors
        if (err instanceof Error && "status" in err) { throw err; }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new Error(`CDN fetch failed after 3 attempts: ${urlPath}`);
  }

  // ── Disk cache ──────────────────────────────────────────────

  private _diskCachePath(key: string): string | undefined {
    if (!this._diskCacheDir) { return undefined; }
    return path.join(this._diskCacheDir, key.replace(/\//g, "_") + ".json");
  }

  private async _readDiskCache(key: string): Promise<{ Version: string; CreationTime: string }[] | undefined> {
    const fp = this._diskCachePath(key);
    if (!fp) { return undefined; }
    try {
      const stat = await fsp.stat(fp);
      if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) { return undefined; }
      const content = await fsp.readFile(fp, "utf8");
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  private _writeDiskCache(key: string, data: unknown): void {
    const fp = this._diskCachePath(key);
    if (!fp) { return; }
    const p = fsp.writeFile(fp, JSON.stringify(data)).catch(() => { /* best-effort */ });
    this._pendingWrites.push(p);
    p.then(() => {
      this._pendingWrites = this._pendingWrites.filter((w) => w !== p);
    });
  }

  /** Wait for all pending disk writes to complete. Useful for testing. */
  async _flushWrites(): Promise<void> {
    await Promise.all(this._pendingWrites);
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
    const disk = await this._readDiskCache(cacheKey);
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
    const cacheKey = `parsed:${type}/${country}`;
    const cached = this._parsedCache.get(cacheKey);
    if (cached) { return cached; }

    const raw = await this._getRawIndex(type, country);
    const versions = this._parseVersions(type, country, raw);
    this._parsedCache.set(cacheKey, versions);
    return versions;
  }

  /**
   * Get only the N newest versions for a type + country.
   * Uses the parsed cache when available to avoid re-parsing.
   */
  async getLatestVersions(
    type: BcArtifactType,
    country: string,
    limit: number,
  ): Promise<{ versions: BcArtifactVersion[]; totalCount: number }> {
    // Try parsed cache first — just slice the tail
    const cacheKey = `parsed:${type}/${country}`;
    const cached = this._parsedCache.get(cacheKey);
    if (cached) {
      return {
        versions: cached.slice(0, limit),
        totalCount: cached.length,
      };
    }

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

    const disk = await this._readDiskCache(key);
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
   * Get all distinct major version numbers for a type + country.
   * This is cheap — just parses the first segment of each version string.
   */
  async getMajorVersions(
    type: BcArtifactType,
    country: string,
  ): Promise<number[]> {
    const raw = await this._getRawIndex(type, country);
    const seen = new Set<number>();
    for (const entry of raw) {
      const major = parseInt(entry.Version.split(".")[0], 10);
      if (!isNaN(major)) { seen.add(major); }
    }
    return Array.from(seen).sort((a, b) => b - a);
  }

  /**
   * Get versions for a specific major version only.
   */
  async getVersionsByMajor(
    type: BcArtifactType,
    country: string,
    major: number,
  ): Promise<BcArtifactVersion[]> {
    const raw = await this._getRawIndex(type, country);
    const filtered = raw.filter((e) => {
      const m = parseInt(e.Version.split(".")[0], 10);
      return m === major;
    });
    return this._parseVersions(type, country, filtered);
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
    this._memCache.clear();
    this._parsedCache.clear();
  }
}
