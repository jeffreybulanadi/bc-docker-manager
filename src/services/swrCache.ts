/**
 * Stale-While-Revalidate (SWR) cache.
 *
 * `get()` returns cached data instantly, then fetches fresh data in the
 * background. When the fresh data arrives and differs from the stale
 * copy, an optional `onUpdate` callback fires so callers (e.g. tree
 * providers) can refresh.
 *
 * This eliminates UI wait times - users always see something while
 * the real data loads behind the scenes.
 */
export class SWRCache<T> {
  private readonly _data = new Map<string, { value: T; ts: number }>();
  private readonly _inflight = new Map<string, Promise<T>>();

  /**
   * @param staleTtlMs  How long data is considered fresh (default 10 s).
   * @param onUpdate    Called when background revalidation produces new data.
   */
  constructor(
    private readonly staleTtlMs: number = 10_000,
    private readonly onUpdate?: (key: string, value: T) => void,
  ) {}

  /**
   * Return cached value immediately if available.
   * If stale (or missing), fetch in the background.
   *
   * @param key     Cache key (e.g. "containers", "images").
   * @param fetcher Async function that produces a fresh value.
   * @returns       The cached (possibly stale) value, or the result of the
   *                first fetch if nothing was cached yet.
   */
  async get(key: string, fetcher: () => Promise<T>): Promise<T> {
    const entry = this._data.get(key);
    const age = entry ? Date.now() - entry.ts : Infinity;

    // Add TTL jitter (+/- 10%) to spread out concurrent expirations.
    const jitter = this.staleTtlMs * 0.1 * (Math.random() * 2 - 1);
    const effectiveTtl = this.staleTtlMs + jitter;

    if (entry && age < effectiveTtl) {
      // Fresh - return as-is, no revalidation needed.
      return entry.value;
    }

    if (entry) {
      // Stale - return immediately, revalidate in background.
      this._revalidate(key, fetcher);
      return entry.value;
    }

    // Cold cache - must await the first fetch.
    return this._fetchAndStore(key, fetcher);
  }

  /** Force the next `get()` to fetch fresh data. */
  invalidate(key: string): void {
    this._data.delete(key);
  }

  /** Invalidate all cached entries. */
  invalidateAll(): void {
    this._data.clear();
  }

  /** Revalidate in background without blocking. */
  private _revalidate(key: string, fetcher: () => Promise<T>): void {
    if (this._inflight.has(key)) {
      return; // already revalidating
    }
    const p = fetcher()
      .then((value) => {
        this._data.set(key, { value, ts: Date.now() });
        this._inflight.delete(key);
        this.onUpdate?.(key, value);
        return value;
      })
      .catch(() => {
        this._inflight.delete(key);
        // Keep stale data on error - better than nothing.
        const stale = this._data.get(key);
        if (stale) { return stale.value; }
        throw new Error(`SWRCache: revalidation failed for key "${key}" with no stale data`);
      });
    this._inflight.set(key, p);
  }

  /** Fetch, store, and return. Used for cold-cache (first call). */
  private async _fetchAndStore(
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    // Deduplicate concurrent cold fetches for the same key.
    const existing = this._inflight.get(key);
    if (existing) {
      return existing;
    }
    const p = fetcher()
      .then((value) => {
        this._data.set(key, { value, ts: Date.now() });
        this._inflight.delete(key);
        return value;
      })
      .catch((err: unknown) => {
        this._inflight.delete(key);
        throw err;
      });
    this._inflight.set(key, p);
    return p;
  }
}
