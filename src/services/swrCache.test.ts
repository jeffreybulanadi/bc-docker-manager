import { SWRCache } from "./swrCache";

describe("SWRCache", () => {
  it("clears inflight entry on cold-cache failure", async () => {
    const cache = new SWRCache<string>(1000);
    const fetcher = jest.fn().mockRejectedValue(new Error("fail"));
    await expect(cache.get("k", fetcher)).rejects.toThrow("fail");
    // Second call must not use the failed inflight promise - it must retry
    fetcher.mockResolvedValue("ok");
    expect(await cache.get("k", fetcher)).toBe("ok");
  });

  it("returns cached value within TTL", async () => {
    const cache = new SWRCache<string>(10_000);
    const fetcher = jest.fn().mockResolvedValue("fresh");
    await cache.get("k", fetcher);
    // Second call should return immediately without calling fetcher again
    await cache.get("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidate forces re-fetch on next get", async () => {
    const cache = new SWRCache<string>(10_000);
    const fetcher = jest.fn().mockResolvedValue("v1");
    await cache.get("k", fetcher);
    cache.invalidate("k");
    fetcher.mockResolvedValue("v2");
    const result = await cache.get("k", fetcher);
    expect(result).toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidateAll clears all entries", async () => {
    const cache = new SWRCache<string>(10_000);
    const fetcher = jest.fn().mockResolvedValue("val");
    await cache.get("a", fetcher);
    await cache.get("b", fetcher);
    cache.invalidateAll();
    fetcher.mockResolvedValue("new");
    await cache.get("a", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
