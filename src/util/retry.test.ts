import { withRetry, isTransientDockerError } from "./retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    expect(await withRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on third attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting attempts", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("permanent"));
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 0 }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("auth failed"));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, retryable: () => false }),
    ).rejects.toThrow("auth failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientDockerError", () => {
  it("returns true for socket errors", () => {
    expect(isTransientDockerError(new Error("socket hang up"))).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isTransientDockerError("string error")).toBe(false);
  });

  it("returns false for permanent errors", () => {
    expect(isTransientDockerError(new Error("container not found"))).toBe(false);
  });
});
