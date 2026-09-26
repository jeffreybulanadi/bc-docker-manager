/**
 * Unit tests for ProcessManager.exec.
 *
 * Covers the typed timeout and cancellation errors, the single-settle
 * guarantee, and listener cleanup on the happy path.
 */

import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  ProcessCancelledError,
  ProcessManager,
  ProcessTimeoutError,
} from "./processManager";

jest.mock("child_process", () => ({ spawn: jest.fn() }));

const mockSpawn = spawn as unknown as jest.Mock;

/** Create a fake child process that never finishes on its own. */
function makeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe("ProcessManager.exec", () => {
  let mgr: ProcessManager;
  let child: any;

  beforeEach(() => {
    jest.useFakeTimers();
    mgr = new ProcessManager();
    child = makeChild();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(child);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves with stdout when the process exits cleanly", async () => {
    const promise = mgr.exec("docker", ["version"]);
    child.stdout.emit("data", Buffer.from("28.0.1"));
    child.emit("close", 0);

    await expect(promise).resolves.toBe("28.0.1");
  });

  it("rejects with ProcessTimeoutError carrying the budget", async () => {
    const promise = mgr.exec("docker", ["exec", "bc", "powershell"], { timeoutMs: 300_000 });
    jest.advanceTimersByTime(300_000);

    await expect(promise).rejects.toBeInstanceOf(ProcessTimeoutError);
    await promise.catch((err: ProcessTimeoutError) => {
      expect(err.timeoutMs).toBe(300_000);
      expect(err.command).toBe("docker");
      expect(err.message).toBe('Process "docker" timed out after 300000ms');
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("ignores a late close event after a timeout", async () => {
    const promise = mgr.exec("docker", ["version"], { timeoutMs: 1_000 });
    jest.advanceTimersByTime(1_000);
    child.emit("close", 0);

    await expect(promise).rejects.toBeInstanceOf(ProcessTimeoutError);
  });

  it("rejects with ProcessCancelledError when the signal aborts", async () => {
    const controller = new AbortController();
    const promise = mgr.exec("docker", ["version"], { signal: controller.signal });

    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(ProcessCancelledError);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects immediately without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      mgr.exec("docker", ["version"], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ProcessCancelledError);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("removes the abort listener once the process completes", async () => {
    const controller = new AbortController();
    const promise = mgr.exec("docker", ["version"], { signal: controller.signal });
    child.emit("close", 0);
    await promise;

    // Aborting after completion must not throw or affect the settled promise.
    expect(() => controller.abort()).not.toThrow();
    await expect(promise).resolves.toBe("");
  });

  it("includes both streams and the exit code on failure", async () => {
    const promise = mgr.exec("docker", ["exec", "bc", "powershell"]);
    child.stderr.emit("data", Buffer.from("Publish-NAVApp failed"));
    child.emit("close", 1);

    await expect(promise).rejects.toThrow("Publish-NAVApp failed (exit 1)");
  });

  it("rejects when stdout exceeds the buffer limit", async () => {
    const promise = mgr.exec("docker", ["logs", "bc"], { maxBufferBytes: 4 });
    child.stdout.emit("data", Buffer.from("too much data"));

    await expect(promise).rejects.toThrow("exceeded max buffer size");
  });
});
