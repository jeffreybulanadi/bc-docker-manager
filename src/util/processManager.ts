import { ChildProcess, spawn, SpawnOptions } from "child_process";

/**
 * Raised when a spawned process exceeds its wall-clock budget.
 *
 * Carries the budget that was exceeded so callers can build an actionable
 * message ("increase setting X, currently N minutes") instead of parsing the
 * message text. The message itself is unchanged from earlier releases so any
 * existing string matching keeps working.
 */
export class ProcessTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`Process "${command}" timed out after ${timeoutMs}ms`);
    this.name = "ProcessTimeoutError";
  }
}

/**
 * Raised when a caller aborts a spawned process through an AbortSignal.
 *
 * Distinct from a timeout so the UI can stay silent on a deliberate cancel
 * rather than presenting a failure the user already knows about.
 */
export class ProcessCancelledError extends Error {
  constructor(readonly command: string) {
    super(`Process "${command}" was cancelled`);
    this.name = "ProcessCancelledError";
  }
}

/** Options accepted by {@link ProcessManager.exec}. */
export interface ExecOptions {
  /** Kill the process if it does not finish in time. Default: 30 000 ms. */
  timeoutMs?: number;
  /** Kill the process if stdout grows beyond this. Default: 10 MiB. */
  maxBufferBytes?: number;
  /**
   * Abort the process early. Aborting kills the local client only; a
   * `docker exec` target keeps running inside the container.
   */
  signal?: AbortSignal;
}

/**
 * Tracks spawned child processes so they can be killed when the
 * extension deactivates. Without this, docker pull / docker exec
 * processes outlive the extension host and waste system resources.
 *
 * Usage:
 *   const mgr = new ProcessManager();
 *   const child = mgr.spawn("docker", ["pull", "mcr.microsoft.com/..."]);
 *   // on deactivate:
 *   mgr.dispose();  // kills all tracked processes
 */
export class ProcessManager {
  private readonly _processes = new Set<ChildProcess>();

  /**
   * Spawn a child process and track it.
   *
   * Uses array args - no shell interpolation, no injection risk.
   */
  spawn(
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess {
    const child = spawn(command, args as string[], {
      ...options,
      shell: false, // explicit: no shell, args are already an array
    });

    this._processes.add(child);

    const cleanup = () => this._processes.delete(child);
    child.on("close", cleanup);
    child.on("error", cleanup);

    return child;
  }

  /**
   * Spawn a process and collect stdout as a string.
   * Rejects if the process exits with a non-zero code.
   *
   * The returned promise settles exactly once. Whichever of completion,
   * timeout, buffer overflow, abort, or spawn error happens first wins, and
   * the timer and abort listener are released at that point.
   */
  exec(
    command: string,
    args: readonly string[],
    options: ExecOptions = {},
  ): Promise<string> {
    const { timeoutMs = 30_000, maxBufferBytes = 10 * 1024 * 1024, signal } = options;

    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ProcessCancelledError(command));
        return;
      }

      const child = this.spawn(command, args);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalSize = 0;
      let settled = false;

      const settle = (action: () => void) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };

      const onAbort = () => {
        child.kill("SIGKILL");
        settle(() => reject(new ProcessCancelledError(command)));
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => reject(new ProcessTimeoutError(command, timeoutMs)));
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > maxBufferBytes) {
          child.kill("SIGKILL");
          settle(() => reject(new Error(`Process "${command}" exceeded max buffer size`)));
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on("close", (code) => {
        settle(() => {
          if (code === 0) {
            resolve(Buffer.concat(stdoutChunks).toString("utf8"));
            return;
          }
          const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
          // Docker on Windows and PowerShell both write diagnostic detail to
          // stdout in some failure modes. Include both streams so callers always
          // have actionable context. Exit code is always appended so callers
          // can pattern-match on it (e.g. 255 = container not running).
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          const body = [stderr, stdout].filter(Boolean).join("\n");
          reject(new Error(body ? `${body} (exit ${code})` : `Process "${command}" exited with code ${code}`));
        });
      });

      child.on("error", (err) => {
        settle(() => reject(err));
      });
    });
  }

  /** Kill all tracked processes and clear the registry. */
  dispose(): void {
    for (const child of this._processes) {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
    }
    this._processes.clear();
  }
}
