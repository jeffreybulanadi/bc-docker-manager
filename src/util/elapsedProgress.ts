/**
 * Live elapsed-time reporting for long-running progress notifications.
 *
 * Operations such as publishing a base application modification can run for
 * tens of minutes with no output. A static "Publishing app…" label is
 * indistinguishable from a hang, which pushes users to cancel work that was
 * about to succeed. Ticking the elapsed time, and showing the limit that will
 * eventually be enforced, makes the wait legible.
 */

/** Minimal shape of vscode.Progress, kept local so this stays testable. */
export interface ProgressSink {
  report(value: { message?: string; increment?: number }): void;
}

/** How often the notification label is refreshed. */
const DEFAULT_TICK_MS = 1_000;

/**
 * Format a duration as "45s" or "12m 05s".
 *
 * Sub-second precision is deliberately dropped: the value is rendered once per
 * second in a notification, where more precision is noise.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

/**
 * Reports "<label> (<elapsed> elapsed)" into a progress sink once per second.
 *
 * One reporter spans a whole multi-step operation. Each call to {@link step}
 * restarts the elapsed counter so the number always describes the step the
 * user is currently waiting on, not the operation as a whole.
 *
 * Always dispose, including on the failure path, or the timer outlives the
 * notification.
 */
export class ElapsedProgressReporter {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _label = "";
  private _limitMs: number | undefined;
  private _startedAt = Date.now();

  constructor(
    private readonly _sink: ProgressSink,
    private readonly _tickMs: number = DEFAULT_TICK_MS,
  ) {}

  /**
   * Begin reporting a new step.
   *
   * @param label    Human-readable description, e.g. "Publishing app".
   * @param limitMs  Budget for this step, appended to the label when given.
   */
  step(label: string, limitMs?: number): void {
    this._label = label;
    this._limitMs = limitMs;
    this._startedAt = Date.now();
    this._emit();

    if (!this._timer) {
      this._timer = setInterval(() => this._emit(), this._tickMs);
      // Never hold the extension host event loop open for a label refresh.
      (this._timer as { unref?: () => void }).unref?.();
    }
  }

  /** Stop the ticker. Safe to call more than once. */
  dispose(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  private _emit(): void {
    const elapsed = formatDuration(Date.now() - this._startedAt);
    const limit = this._limitMs === undefined
      ? ""
      : `, limit ${formatDuration(this._limitMs)}`;
    this._sink.report({ message: `${this._label} (${elapsed} elapsed${limit})` });
  }
}
