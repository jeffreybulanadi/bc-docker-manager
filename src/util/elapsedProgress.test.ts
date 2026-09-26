/**
 * Unit tests for the elapsed-time progress reporter.
 *
 * Covers duration formatting, per-step counter resets, the optional limit
 * suffix, and timer cleanup.
 */

import { ElapsedProgressReporter, formatDuration } from "./elapsedProgress";

describe("formatDuration", () => {
  it("renders sub-minute durations in seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_400)).toBe("45s");
  });

  it("renders longer durations as minutes and zero-padded seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(725_000)).toBe("12m 05s");
    expect(formatDuration(1_800_000)).toBe("30m 00s");
  });

  it("clamps negative input to zero", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("ElapsedProgressReporter", () => {
  const sink = { report: jest.fn() };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    sink.report.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reports the label immediately when a step starts", () => {
    const reporter = new ElapsedProgressReporter(sink);
    reporter.step("Publishing app");

    expect(sink.report).toHaveBeenCalledWith({ message: "Publishing app (0s elapsed)" });
    reporter.dispose();
  });

  it("appends the limit when one is supplied", () => {
    const reporter = new ElapsedProgressReporter(sink);
    reporter.step("Publishing app", 1_800_000);

    expect(sink.report).toHaveBeenCalledWith({
      message: "Publishing app (0s elapsed, limit 30m 00s)",
    });
    reporter.dispose();
  });

  it("ticks the elapsed time once per interval", () => {
    const reporter = new ElapsedProgressReporter(sink);
    reporter.step("Publishing app");

    jest.advanceTimersByTime(3_000);

    expect(sink.report).toHaveBeenLastCalledWith({ message: "Publishing app (3s elapsed)" });
    reporter.dispose();
  });

  it("restarts the counter on each step", () => {
    const reporter = new ElapsedProgressReporter(sink);
    reporter.step("Publishing app");
    jest.advanceTimersByTime(90_000);

    reporter.step("Syncing app");
    expect(sink.report).toHaveBeenLastCalledWith({ message: "Syncing app (0s elapsed)" });

    jest.advanceTimersByTime(2_000);
    expect(sink.report).toHaveBeenLastCalledWith({ message: "Syncing app (2s elapsed)" });
    reporter.dispose();
  });

  it("stops reporting after dispose and tolerates a second dispose", () => {
    const reporter = new ElapsedProgressReporter(sink);
    reporter.step("Publishing app");
    reporter.dispose();

    const callsAfterDispose = sink.report.mock.calls.length;
    jest.advanceTimersByTime(10_000);

    expect(sink.report).toHaveBeenCalledTimes(callsAfterDispose);
    expect(() => reporter.dispose()).not.toThrow();
  });
});
