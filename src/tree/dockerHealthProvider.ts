import * as vscode from "vscode";
import { exec } from "child_process";

// ────────────────────────── Types ───────────────────────────────

export type CheckStatus = "ok" | "warn" | "error" | "checking";

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Command to run to fix this issue (if any). */
  fixCommand?: string;
}

// ────────────────────────── Tree Items ──────────────────────────

export class HealthCheckItem extends vscode.TreeItem {
  constructor(public readonly check: HealthCheck) {
    super(check.label, vscode.TreeItemCollapsibleState.None);

    this.description = check.detail;
    this.contextValue = `health_${check.id}_${check.status}`;

    switch (check.status) {
      case "ok":
        this.iconPath = new vscode.ThemeIcon(
          "pass-filled",
          new vscode.ThemeColor("charts.green"),
        );
        break;
      case "warn":
        this.iconPath = new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("charts.yellow"),
        );
        break;
      case "error":
        this.iconPath = new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("charts.red"),
        );
        break;
      case "checking":
        this.iconPath = new vscode.ThemeIcon("sync~spin");
        break;
    }

    if (check.fixCommand) {
      this.command = {
        title: "Fix",
        command: check.fixCommand,
      };
    }

    const lines: string[] = [];
    switch (check.status) {
      case "ok":    lines.push(`$(pass-filled) **${check.label}** — OK`); break;
      case "warn":  lines.push(`$(warning) **${check.label}** — Warning`); break;
      case "error": lines.push(`$(error) **${check.label}** — Not Available`); break;
      default:      lines.push(`$(sync~spin) **${check.label}** — Checking…`);
    }
    lines.push("", check.detail);
    if (check.fixCommand) {
      lines.push("", "_Click to fix this issue._");
    }
    this.tooltip = new vscode.MarkdownString(lines.join("\n"));
  }
}

// ────────────────────────── Provider ───────────────────────────

/**
 * Tree data provider — simplified environment readiness.
 *
 * Shows exactly two items:
 *  1. **Windows Features** — Hyper-V + Containers (both required, enabled together)
 *  2. **Docker Engine**    — CLI installed and daemon running
 *
 * Auto-refreshes every 15 seconds.
 */
export class DockerHealthProvider
  implements vscode.TreeDataProvider<HealthCheckItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<HealthCheckItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _checks: HealthCheck[] = [];
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _disposed = false;
  private _allOk = false;

  constructor() {
    this._runChecks();
    this._timer = setInterval(() => this._runChecks(), 15_000);
  }

  get isAllHealthy(): boolean { return this._allOk; }
  get checks(): readonly HealthCheck[] { return this._checks; }

  getTreeItem(element: HealthCheckItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<HealthCheckItem[]> {
    return this._checks.map((c) => new HealthCheckItem(c));
  }

  refresh(): void { this._runChecks(); }

  dispose(): void {
    this._disposed = true;
    if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
  }

  // ── Core check logic ────────────────────────────────────────

  private async _runChecks(): Promise<void> {
    if (this._disposed) { return; }

    const checks: HealthCheck[] = [];

    // Step 1: Windows Features (Hyper-V + Containers)
    if (process.platform === "win32") {
      checks.push(await this._checkWindowsFeatures());
    }

    // Step 2: Docker Engine (installed + running)
    checks.push(await this._checkDockerEngine());

    this._checks = checks;
    this._allOk = checks.every((c) => c.status === "ok");

    const byId = new Map(checks.map((c) => [c.id, c.status]));
    vscode.commands.executeCommand("setContext", "bcDockerManager.dockerReady", this._allOk);
    vscode.commands.executeCommand("setContext", "bcDockerManager.featuresOk", byId.get("features") === "ok");
    vscode.commands.executeCommand("setContext", "bcDockerManager.dockerOk", byId.get("docker") === "ok");

    this._onDidChangeTreeData.fire();
  }

  // ── Individual checks ───────────────────────────────────────

  /**
   * Combined Hyper-V + Windows Containers check.
   * Both are Windows Optional Features — they're enabled together
   * and both require a reboot, so we treat them as one step.
   */
  private async _checkWindowsFeatures(): Promise<HealthCheck> {
    try {
      const [hyperv, containers] = await Promise.all([
        this._getFeatureState("Microsoft-Hyper-V"),
        this._getFeatureState("Containers"),
      ]);

      if (hyperv === "enabled" && containers === "enabled") {
        return {
          id: "features",
          label: "Step 1 · Windows Features",
          status: "ok",
          detail: "Hyper-V & Containers enabled",
        };
      }

      const missing: string[] = [];
      if (hyperv !== "enabled") { missing.push("Hyper-V"); }
      if (containers !== "enabled") { missing.push("Containers"); }

      return {
        id: "features",
        label: "Step 1 · Windows Features",
        status: "error",
        detail: `${missing.join(" & ")} not enabled`,
        fixCommand: "bcDockerManager.enableWindowsFeatures",
      };
    } catch {
      // Fallback: check Windows services when PS feature check fails (non-admin).
      // vmms   = Hyper-V Virtual Machine Management (exists only when Hyper-V feature is enabled)
      // vmcompute = Host Compute Service (exists only when Containers feature is enabled)
      // This is more reliable than the old systeminfo approach, which could
      // false-positive on VBS / HVCI / Credential Guard / WSL2 remnants.
      try {
        const [hypervSvc, containerSvc] = await Promise.all([
          this._isServiceInstalled("vmms"),
          this._isServiceInstalled("vmcompute"),
        ]);

        if (hypervSvc && containerSvc) {
          return {
            id: "features",
            label: "Step 1 · Windows Features",
            status: "ok",
            detail: "Hyper-V & Containers enabled",
          };
        }

        const missing: string[] = [];
        if (!hypervSvc) { missing.push("Hyper-V"); }
        if (!containerSvc) { missing.push("Containers"); }

        return {
          id: "features",
          label: "Step 1 · Windows Features",
          status: "error",
          detail: `${missing.join(" & ")} not enabled`,
          fixCommand: "bcDockerManager.enableWindowsFeatures",
        };
      } catch {
        return {
          id: "features",
          label: "Step 1 · Windows Features",
          status: "warn",
          detail: "Could not verify — run as admin to check",
          fixCommand: "bcDockerManager.enableWindowsFeatures",
        };
      }
    }
  }

  /**
   * Combined Docker CLI + daemon check.
   * From the user's perspective, "Docker Engine" is one thing.
   */
  private async _checkDockerEngine(): Promise<HealthCheck> {
    // First check if docker CLI is even on PATH
    let version: string | undefined;
    try {
      const out = await this._exec("docker --version", 5000);
      version = out.trim().replace(/^Docker version\s*/i, "").split(",")[0];
    } catch {
      return {
        id: "docker",
        label: "Step 2 · Docker Engine",
        status: "error",
        detail: "Not installed",
        fixCommand: "bcDockerManager.installDockerEngine",
      };
    }

    // Docker CLI exists — check if daemon is running
    try {
      await this._exec("docker info", 10_000);
      return {
        id: "docker",
        label: "Step 2 · Docker Engine",
        status: "ok",
        detail: `Running (${version})`,
      };
    } catch {
      return {
        id: "docker",
        label: "Step 2 · Docker Engine",
        status: "warn",
        detail: `Installed (${version}) but not running`,
        fixCommand: "bcDockerManager.startDockerEngine",
      };
    }
  }

  // ── Fix actions ─────────────────────────────────────────────

  /**
   * Enable both Hyper-V and Windows Containers in one elevated prompt.
   */
  static async enableWindowsFeatures(): Promise<void> {
    const command =
      "Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart; " +
      "Enable-WindowsOptionalFeature -Online -FeatureName Containers -All -NoRestart";
    await DockerHealthProvider._runElevated(command, "Enable Windows Features");
  }

  /**
   * Start Docker Engine Windows service.
   */
  static async startDockerEngine(): Promise<boolean> {
    const serviceNames = ["com.docker.service", "docker"];
    for (const svc of serviceNames) {
      try {
        await new Promise<void>((resolve, reject) => {
          exec(`net start "${svc}"`, { timeout: 30_000 }, (err) => {
            if (err) { reject(err); } else { resolve(); }
          });
        });
        return true;
      } catch { /* try next */ }
    }
    return false;
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Check if a Windows service is installed (exists) regardless of its
   * running state.  `sc query` exits with code 1060 when the service
   * does not exist and returns 0 when it does (even if stopped).
   */
  private async _isServiceInstalled(serviceName: string): Promise<boolean> {
    try {
      await this._exec(`sc query "${serviceName}"`, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  private async _getFeatureState(featureName: string): Promise<string> {
    const output = await this._exec(
      `powershell -NoProfile -Command "(Get-WindowsOptionalFeature -Online -FeatureName ${featureName}).State"`,
      15_000,
    );
    return output.trim().toLowerCase();
  }

  private static async _runElevated(psCommand: string, title: string): Promise<void> {
    const fullCmd =
      `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','${psCommand}; Write-Host Done; Start-Sleep 3'`;

    return new Promise((resolve) => {
      exec(
        `powershell -NoProfile -Command "${fullCmd}"`,
        { timeout: 30_000 },
        (err) => {
          if (err) {
            vscode.window.showWarningMessage(
              `${title}: elevated prompt was cancelled or failed.`,
            );
          } else {
            vscode.window.showInformationMessage(
              `${title}: done! A restart is required for changes to take effect.`,
              "Restart Now",
            ).then((action) => {
              if (action === "Restart Now") {
                exec('shutdown /r /t 30 /c "Restarting for Docker features"');
                vscode.window.showInformationMessage("System will restart in 30 seconds.");
              }
            });
          }
          resolve();
        },
      );
    });
  }

  private _exec(command: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { timeout: timeoutMs }, (err, stdout) => {
        if (err) { reject(err); } else { resolve(stdout); }
      });
    });
  }
}
