import * as vscode from "vscode";
import { sendError } from "./telemetry";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured output channel logger.
 *
 * - All messages are timestamped and level-tagged.
 * - error() automatically forwards to telemetry.
 * - A single OutputChannel is shared across the extension lifetime.
 *
 * This replaces scattered `output.appendLine()` calls with a consistent
 * leveled interface that is easy to search in VS Code's output panel.
 */
export class Logger {
  private readonly _channel: vscode.OutputChannel;
  private _level: LogLevel = "info";

  constructor(channelName: string) {
    this._channel = vscode.window.createOutputChannel(channelName);
  }

  /** Set the minimum level to emit. Messages below this are dropped. */
  setLevel(level: LogLevel): void {
    this._level = level;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this._emit("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this._emit("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this._emit("warn", message, context);
  }

  /**
   * Log an error and forward it to telemetry.
   * @param eventName  Telemetry event name (e.g. "docker/pullFailed").
   */
  error(
    message: string,
    eventName: string,
    context?: Record<string, unknown>,
  ): void {
    this._emit("error", message, context);
    sendError(eventName, { message, ...this._flatten(context) });
  }

  /** Expose the output channel for use with pullImageWithProgress etc. */
  get outputChannel(): vscode.OutputChannel {
    return this._channel;
  }

  dispose(): void {
    this._channel.dispose();
  }

  private _emit(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (!this._shouldEmit(level)) { return; }
    const ts = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    const suffix = context ? ` | ${JSON.stringify(context)}` : "";
    this._channel.appendLine(`[${ts}] ${tag} ${message}${suffix}`);
  }

  private _shouldEmit(level: LogLevel): boolean {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    return order.indexOf(level) >= order.indexOf(this._level);
  }

  private _flatten(
    context?: Record<string, unknown>,
  ): Record<string, string> {
    if (!context) { return {}; }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(context)) {
      out[k] = String(v);
    }
    return out;
  }
}
