import { ChildProcess, spawn, SpawnOptions } from "child_process";

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
   * @param timeoutMs  Kill the process if it does not finish in time.
   */
  exec(
    command: string,
    args: readonly string[],
    options: { timeoutMs?: number; maxBufferBytes?: number } = {},
  ): Promise<string> {
    const { timeoutMs = 30_000, maxBufferBytes = 10 * 1024 * 1024 } = options;

    return new Promise<string>((resolve, reject) => {
      const child = this.spawn(command, args);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalSize = 0;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        reject(new Error(`Process "${command}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > maxBufferBytes) {
          child.kill("SIGKILL");
          clearTimeout(timer);
          reject(new Error(`Process "${command}" exceeded max buffer size`));
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) { return; }
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString("utf8"));
        } else {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(new Error(stderr || `Process "${command}" exited with code ${code}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
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
