/**
 * Unit tests for BcArtifactsService.
 *
 * The global `fetch` is replaced with a jest.fn() so no real HTTP calls are made.
 * Disk caching is disabled (no storagePath set) to keep tests side-effect-free.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BcArtifactsService } from "./bcArtifactsService";

// ─── helpers ────────────────────────────────────────────────────

/** Build a raw CDN index entry. */
function rawEntry(version: string, creationTime = "2024-01-01T00:00:00Z") {
  return { Version: version, CreationTime: creationTime };
}

/** Create a service instance with fetch mocked. */
function makeService(fetchImpl: jest.Mock) {
  // The module declares `fetch` as a global — assign it to globalThis for the test
  (globalThis as unknown as Record<string, unknown>)["fetch"] = fetchImpl;
  return new BcArtifactsService();
}

function mockFetchJson(data: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status = 404, statusText = "Not Found"): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve(""),
  });
}

// ─── _parseVersions (tested indirectly via getVersions) ─────────

describe("BcArtifactsService — version parsing and sorting", () => {
  it("maps raw CDN entries to BcArtifactVersion objects", async () => {
    const raw = [rawEntry("27.4.45366.46497", "2024-06-01T12:00:00Z")];
    const svc = makeService(mockFetchJson(raw));
    const versions = await svc.getVersions("sandbox", "us");
    expect(versions).toHaveLength(1);
    const v = versions[0];
    expect(v.version).toBe("27.4.45366.46497");
    expect(v.major).toBe(27);
    expect(v.minor).toBe(4);
    expect(v.type).toBe("sandbox");
    expect(v.country).toBe("us");
    expect(v.creationTime).toBe("2024-06-01T12:00:00Z");
    expect(v.artifactUrl).toMatch(/^https:\/\/bcartifacts/);
    expect(v.artifactUrl).toContain("/sandbox/27.4.45366.46497/us");
  });

  it("sorts newest-first by major, then minor, then patch", async () => {
    const raw = [
      rawEntry("26.5.0.0"),
      rawEntry("27.4.0.0"),
      rawEntry("27.3.0.0"),
      rawEntry("26.6.0.0"),
    ];
    const svc = makeService(mockFetchJson(raw));
    const versions = await svc.getVersions("sandbox", "w1");
    const majors = versions.map((v) => v.major);
    // All 27s should come before all 26s
    expect(majors.indexOf(27)).toBeLessThan(majors.indexOf(26));
    // Within major 27, minor 4 before minor 3
    const v27 = versions.filter((v) => v.major === 27);
    expect(v27[0].minor).toBe(4);
    expect(v27[1].minor).toBe(3);
  });

  it("handles malformed version strings gracefully (defaults major/minor to 0)", async () => {
    const raw = [rawEntry("bad-version")];
    const svc = makeService(mockFetchJson(raw));
    const versions = await svc.getVersions("sandbox", "us");
    expect(versions[0].major).toBe(0);
    expect(versions[0].minor).toBe(0);
  });
});

// ─── getLatestVersions ───────────────────────────────────────────

describe("BcArtifactsService.getLatestVersions", () => {
  const raw = Array.from({ length: 50 }, (_, i) =>
    rawEntry(`${20 + Math.floor(i / 5)}.${i % 5}.0.0`)
  );

  it("returns at most `limit` versions", async () => {
    const svc = makeService(mockFetchJson(raw));
    const { versions } = await svc.getLatestVersions("sandbox", "us", 10);
    expect(versions.length).toBeLessThanOrEqual(10);
  });

  it("reports the correct totalCount", async () => {
    const svc = makeService(mockFetchJson(raw));
    const { totalCount } = await svc.getLatestVersions("sandbox", "us", 5);
    expect(totalCount).toBe(50);
  });

  it("returns fewer than limit when index has fewer entries", async () => {
    const svc = makeService(mockFetchJson([rawEntry("27.0.0.0")]));
    const { versions, totalCount } = await svc.getLatestVersions("sandbox", "us", 100);
    expect(versions).toHaveLength(1);
    expect(totalCount).toBe(1);
  });
});

// ─── getLatestPerMajor ───────────────────────────────────────────

describe("BcArtifactsService.getLatestPerMajor", () => {
  it("returns one entry per major version", async () => {
    const raw = [
      rawEntry("27.4.0.0"),
      rawEntry("27.3.0.0"),
      rawEntry("26.5.0.0"),
      rawEntry("26.4.0.0"),
      rawEntry("25.0.0.0"),
    ];
    const svc = makeService(mockFetchJson(raw));
    const result = await svc.getLatestPerMajor("sandbox", "w1");
    expect(result).toHaveLength(3);
    // Should pick the newest minor per major
    const v27 = result.find((v) => v.major === 27);
    expect(v27?.minor).toBe(4);
    const v26 = result.find((v) => v.major === 26);
    expect(v26?.minor).toBe(5);
  });

  it("sorts result newest-major-first", async () => {
    const raw = [rawEntry("25.0.0.0"), rawEntry("27.0.0.0"), rawEntry("26.0.0.0")];
    const svc = makeService(mockFetchJson(raw));
    const result = await svc.getLatestPerMajor("onprem", "w1");
    expect(result.map((v) => v.major)).toEqual([27, 26, 25]);
  });
});

// ─── getCountries ────────────────────────────────────────────────

describe("BcArtifactsService.getCountries", () => {
  it("returns sorted country list from CDN", async () => {
    const countries = ["us", "w1", "de", "gb"];
    const svc = makeService(mockFetchJson(countries));
    const result = await svc.getCountries("sandbox");
    expect(result).toEqual(["de", "gb", "us", "w1"]);
  });
});

// ─── in-memory caching ───────────────────────────────────────────

describe("BcArtifactsService — in-memory cache", () => {
  it("only calls fetch once for the same type/country on repeated calls", async () => {
    const fetchMock = mockFetchJson([rawEntry("27.0.0.0")]);
    const svc = makeService(fetchMock);
    await svc.getVersions("sandbox", "us");
    await svc.getVersions("sandbox", "us");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls fetch separately for different countries", async () => {
    const fetchMock = mockFetchJson([rawEntry("27.0.0.0")]);
    const svc = makeService(fetchMock);
    await svc.getVersions("sandbox", "us");
    await svc.getVersions("sandbox", "w1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── testConnection / isReachable ────────────────────────────────

describe("BcArtifactsService.testConnection", () => {
  it("returns OK message with country count on success", async () => {
    const svc = makeService(mockFetchJson(["us", "w1", "de"]));
    const result = await svc.testConnection();
    expect(result).toMatch(/^OK/);
    expect(result).toContain("3 countries");
  });

  it("returns FAILED message on HTTP error", async () => {
    const svc = makeService(mockFetchError(500, "Internal Server Error"));
    const result = await svc.testConnection();
    expect(result).toMatch(/^FAILED/);
    expect(result).toContain("500");
  });

  it("returns FAILED message on network error", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("Network unreachable"));
    const svc = makeService(fetchMock);
    const result = await svc.testConnection();
    expect(result).toMatch(/^FAILED/);
    expect(result).toContain("Network unreachable");
  });
});

describe("BcArtifactsService.isReachable", () => {
  it("returns true on successful fetch", async () => {
    const svc = makeService(mockFetchJson(["us"]));
    expect(await svc.isReachable()).toBe(true);
  });

  it("returns false on HTTP error", async () => {
    const svc = makeService(mockFetchError(503));
    expect(await svc.isReachable()).toBe(false);
  });
});

// ─── disk cache ──────────────────────────────────────────────────

describe("BcArtifactsService — disk cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-artifacts-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a disk cache file after fetching data", async () => {
    const raw = [rawEntry("27.0.0.0")];
    const svc = makeService(mockFetchJson(raw));
    svc.setStoragePath(tmpDir);

    await svc.getVersions("sandbox", "us");

    const cacheFile = path.join(tmpDir, "artifact-cache", "sandbox_us.json");
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(cached).toEqual(raw);
  });

  it("uses disk cache when memory cache is empty (no second fetch)", async () => {
    const raw = [rawEntry("27.0.0.0")];
    const fetchMock1 = mockFetchJson(raw);
    const svc1 = makeService(fetchMock1);
    svc1.setStoragePath(tmpDir);
    await svc1.getVersions("sandbox", "us");
    expect(fetchMock1).toHaveBeenCalledTimes(1);

    // New service instance — fresh memory cache but same disk cache dir
    const fetchMock2 = mockFetchJson(raw);
    const svc2 = makeService(fetchMock2);
    svc2.setStoragePath(tmpDir);
    await svc2.getVersions("sandbox", "us");
    expect(fetchMock2).not.toHaveBeenCalled();
  });

  it("re-fetches when disk cache file has expired TTL", async () => {
    const raw = [rawEntry("27.0.0.0")];
    const fetchMock1 = mockFetchJson(raw);
    const svc1 = makeService(fetchMock1);
    svc1.setStoragePath(tmpDir);
    await svc1.getVersions("sandbox", "us");

    // Set file mtime to 2 hours ago so the cache is expired
    const cacheFile = path.join(tmpDir, "artifact-cache", "sandbox_us.json");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(cacheFile, twoHoursAgo, twoHoursAgo);

    // New service — disk cache expired, must fetch again
    const fetchMock2 = mockFetchJson(raw);
    const svc2 = makeService(fetchMock2);
    svc2.setStoragePath(tmpDir);
    await svc2.getVersions("sandbox", "us");
    expect(fetchMock2).toHaveBeenCalledTimes(1);
  });
});

// ─── getVersionsGroupedByMajor ───────────────────────────────────

describe("BcArtifactsService.getVersionsGroupedByMajor", () => {
  const raw = [
    rawEntry("27.4.0.0"),
    rawEntry("27.3.0.0"),
    rawEntry("26.5.0.0"),
    rawEntry("26.4.0.0"),
    rawEntry("25.0.0.0"),
  ];

  it("returns a Map grouped by major version", async () => {
    const svc = makeService(mockFetchJson(raw));
    const grouped = await svc.getVersionsGroupedByMajor("sandbox", "us");
    expect(grouped).toBeInstanceOf(Map);
    expect(grouped.size).toBe(3);
    expect(grouped.has(27)).toBe(true);
    expect(grouped.has(26)).toBe(true);
    expect(grouped.has(25)).toBe(true);
  });

  it("sorts versions newest-first within each major group", async () => {
    const svc = makeService(mockFetchJson(raw));
    const grouped = await svc.getVersionsGroupedByMajor("sandbox", "us");
    const v27 = grouped.get(27)!;
    expect(v27[0].minor).toBe(4);
    expect(v27[1].minor).toBe(3);
    const v26 = grouped.get(26)!;
    expect(v26[0].minor).toBe(5);
    expect(v26[1].minor).toBe(4);
  });

  it("orders groups newest-major-first", async () => {
    const svc = makeService(mockFetchJson(raw));
    const grouped = await svc.getVersionsGroupedByMajor("sandbox", "us");
    const keys = Array.from(grouped.keys());
    expect(keys).toEqual([27, 26, 25]);
  });
});

// ─── dispose ─────────────────────────────────────────────────────

describe("BcArtifactsService.dispose", () => {
  it("clears cache so re-fetching triggers a new network call", async () => {
    const fetchMock = mockFetchJson([rawEntry("27.0.0.0")]);
    const svc = makeService(fetchMock);
    await svc.getVersions("sandbox", "us");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    svc.dispose();

    await svc.getVersions("sandbox", "us");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
