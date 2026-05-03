import * as vscode from "vscode";

const CONFIG_SECTION = "bcDockerManager";

/**
 * Centralized VS Code configuration reader.
 *
 * All configuration keys are accessed through typed accessor methods.
 * This eliminates scattered `vscode.workspace.getConfiguration()` calls
 * and makes it easy to find all settings in one place.
 *
 * Implements vscode.Disposable so the change listener can be cleaned up.
 */
export class ConfigurationService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private readonly _listener: vscode.Disposable;

  constructor() {
    this._listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        this._onDidChange.fire();
      }
    });
  }

  /** Show release notes after an update. Default: true. */
  get showReleaseNotesOnUpdate(): boolean {
    return this._get<boolean>("showReleaseNotesOnUpdate", true);
  }

  /** Memory limit for new BC containers, e.g. "8G". Default: "8G". */
  get containerMemoryLimit(): string {
    return this._get<string>("containerMemoryLimit", "8G");
  }

  /** SWR cache TTL in milliseconds. Default: 10000. */
  get cacheTtlMs(): number {
    return this._get<number>("cacheTtlMs", 10_000);
  }

  /** Maximum number of retry attempts for Docker CLI calls. Default: 3. */
  get dockerRetryMaxAttempts(): number {
    return this._get<number>("dockerRetryMaxAttempts", 3);
  }

  /** Log level for the output channel. Default: "info". */
  get logLevel(): "debug" | "info" | "warn" | "error" {
    return this._get<"debug" | "info" | "warn" | "error">("logLevel", "info");
  }

  dispose(): void {
    this._listener.dispose();
    this._onDidChange.dispose();
  }

  private _get<T>(key: string, defaultValue: T): T {
    return (
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<T>(key) ?? defaultValue
    );
  }
}
