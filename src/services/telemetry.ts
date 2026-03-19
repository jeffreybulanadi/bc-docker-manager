import { TelemetryReporter } from "@vscode/extension-telemetry";

/**
 * Lightweight telemetry wrapper for Azure Application Insights.
 *
 * - Does nothing if the connection string is empty or the user has
 *   telemetry disabled in VS Code settings.
 * - Call `sendEvent()` for usage tracking and `sendError()` for
 *   errors you want to monitor proactively.
 *
 * To activate:
 *   1. Create an Azure Application Insights resource (free tier).
 *   2. Replace the placeholder below with the connection string.
 */

// TODO: Replace with your Azure Application Insights connection string.
// Find it in Azure Portal → Application Insights → Overview → Connection String.
const CONNECTION_STRING = "";

let reporter: TelemetryReporter | undefined;

export function initTelemetry(): void {
  if (!CONNECTION_STRING) { return; }
  try {
    reporter = new TelemetryReporter(CONNECTION_STRING);
  } catch {
    // Silently ignore — telemetry is optional.
  }
}

/** Track a named event with optional properties & measurements. */
export function sendEvent(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryEvent(name, properties, measurements);
}

/** Track an error with optional properties & measurements. */
export function sendError(
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryErrorEvent(name, properties, measurements);
}

/** Flush pending telemetry and dispose the reporter. */
export function disposeTelemetry(): void {
  reporter?.dispose();
  reporter = undefined;
}
