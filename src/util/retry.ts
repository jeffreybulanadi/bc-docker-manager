/**
 * Retry an async operation with exponential backoff and full jitter.
 *
 * Full jitter prevents retry storms when multiple callers fail at the
 * same time. Each delay is chosen uniformly at random from [0, cap]
 * where cap doubles after every attempt up to maxDelayMs.
 *
 * Reference: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Initial base delay in ms before jitter. Default: 200. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 5000. */
  maxDelayMs?: number;
  /**
   * Return true if the error is transient and should be retried.
   * By default, all errors are retried.
   */
  retryable?: (err: unknown) => boolean;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` up to `maxAttempts` times, retrying on transient errors.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    retryable = () => true,
  } = options;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !retryable(err)) {
        throw err;
      }
      // Full jitter: sleep uniformly in [0, min(cap, base * 2^attempt)]
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.random() * cap;
      await sleep(jitter);
    }
  }
  throw lastErr;
}

/**
 * Return true if an error from a Docker CLI call is likely transient.
 * Examples: socket temporarily unavailable, daemon busy, network blip.
 */
export function isTransientDockerError(err: unknown): boolean {
  if (!(err instanceof Error)) { return false; }
  const msg = err.message.toLowerCase();
  return (
    msg.includes("socket") ||
    msg.includes("connection refused") ||
    msg.includes("context deadline exceeded") ||
    msg.includes("i/o timeout") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("resource temporarily unavailable")
  );
}
