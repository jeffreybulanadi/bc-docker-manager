import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DockerService } from "./dockerService";
import { SWRCache } from "../services/swrCache";

// ────────────────────────── Constants ───────────────────────────

const EXEC_TIMEOUT_MS = 120_000; // BC operations can be slow
const BC_SERVER_INSTANCE = "BC";
const CONTAINER_TEMP = "C:\\run\\my";

/** Max bytes per write chunk: base64 of 5 000 bytes is ~6 700 chars, safely under the 8 191-char cmd.exe command line limit. */
const CONTAINER_WRITE_CHUNK = 5_000;
/** Max bytes per read chunk: 50 000 bytes produces ~66 KB of base64 stdout, well under the 10 MB exec buffer. */
const CONTAINER_READ_CHUNK = 50_000;

/**
 * Import the NAV/BC management module inside the container.
 * Required because we use `-NoProfile` to avoid slow profile loading
 * and unpredictable stdout. Covers both legacy NAV and modern BC paths.
 */
const NAV_MODULE_IMPORT =
  "$navModule = Get-ChildItem 'C:\\Program Files\\Microsoft Dynamics*\\*\\Service\\NavAdminTool.ps1' -ErrorAction SilentlyContinue | Select-Object -First 1; " +
  "if ($navModule) { Import-Module $navModule.FullName -DisableNameChecking -ErrorAction SilentlyContinue }; ";

// ────────────────────────── Service ────────────────────────────

/**
 * BC-specific operations that run inside a Business Central container
 * via `docker exec` + PowerShell cmdlets. All file transfers use chunked
 * Base64 over docker exec to support both Process and Hyper-V isolation.
 *
 * This keeps dockerService.ts focused on generic Docker operations.
 */
export class BcContainerService {
  private readonly _volumeCache: SWRCache<DockerVolume[]>;

  constructor(private docker: DockerService) {
    this._volumeCache = new SWRCache<DockerVolume[]>(30_000);
  }

  // ── shell helper ─────────────────────────────────────────────

  private exec(command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /** Run a PowerShell utility command inside a container (no NAV module). */
  private async execInContainer(
    containerName: string,
    psCommand: string,
    timeoutMs = EXEC_TIMEOUT_MS,
  ): Promise<string> {
    const escaped = psCommand.replace(/"/g, '\\"');
    return this.exec(
      `docker exec ${containerName} powershell -NoProfile -Command "${escaped}"`,
      timeoutMs,
    );
  }

  /** Run a NAV/BC PowerShell cmdlet inside a container (imports NavAdminTool). */
  private async execNavInContainer(
    containerName: string,
    psCommand: string,
    timeoutMs = EXEC_TIMEOUT_MS,
  ): Promise<string> {
    const escaped = (NAV_MODULE_IMPORT + psCommand).replace(/"/g, '\\"');
    return this.exec(
      `docker exec ${containerName} powershell -NoProfile -Command "${escaped}"`,
      timeoutMs,
    );
  }

  /** Escape single quotes in a path for use inside a PowerShell single-quoted string. */
  private static escapePsPath(p: string): string {
    return p.replace(/'/g, "''");
  }

  /**
   * Write a host file into a container using chunked Base64 via docker exec.
   * Works with both Hyper-V and Process isolation containers.
   * docker cp is not used because Hyper-V containers block direct filesystem operations.
   */
  private async writeFileToContainer(
    containerName: string,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    const content = fs.readFileSync(hostPath);
    const ep = BcContainerService.escapePsPath(containerPath);

    if (content.length === 0) {
      await this.execInContainer(containerName, `[System.IO.File]::WriteAllBytes('${ep}',@())`, 10_000);
      return;
    }

    for (let offset = 0; offset < content.length; offset += CONTAINER_WRITE_CHUNK) {
      const b64 = content.slice(offset, offset + CONTAINER_WRITE_CHUNK).toString("base64");
      const ps = offset === 0
        ? `[System.IO.File]::WriteAllBytes('${ep}',[System.Convert]::FromBase64String('${b64}'))`
        : `$s=[System.IO.File]::Open('${ep}',[System.IO.FileMode]::Append,[System.IO.FileAccess]::Write);$b=[System.Convert]::FromBase64String('${b64}');$s.Write($b,0,$b.Length);$s.Close()`;
      await this.execInContainer(containerName, ps, 30_000);
    }
  }

  /**
   * Read a file from a container to the host using chunked Base64 via docker exec.
   * Works with both Hyper-V and Process isolation containers.
   */
  private async readFileFromContainer(
    containerName: string,
    containerPath: string,
    hostPath: string,
  ): Promise<void> {
    const ep = BcContainerService.escapePsPath(containerPath);
    const sizeStr = await this.execInContainer(
      containerName,
      `(Get-Item '${ep}').Length`,
      10_000,
    );
    const fileSize = parseInt(sizeStr.trim(), 10);
    const parts: Buffer[] = [];

    for (let offset = 0; offset < fileSize; offset += CONTAINER_READ_CHUNK) {
      const len = Math.min(CONTAINER_READ_CHUNK, fileSize - offset);
      const b64 = await this.execInContainer(
        containerName,
        `$f=[System.IO.File]::OpenRead('${ep}');$f.Seek(${offset},[System.IO.SeekOrigin]::Begin)|Out-Null;$b=New-Object byte[] ${len};$f.Read($b,0,${len})|Out-Null;$f.Close();[System.Convert]::ToBase64String($b)`,
        30_000,
      );
      parts.push(Buffer.from(b64.trim(), "base64"));
    }

    fs.writeFileSync(hostPath, Buffer.concat(parts));
  }

  /**
   * Copy a host directory into a container using a zip transfer via docker exec.
   * Compresses the directory on the host, transfers the zip in Base64 chunks,
   * and expands it inside the container. Works with Hyper-V containers.
   */
  private async writeDirToContainer(
    containerName: string,
    hostDir: string,
    containerDir: string,
  ): Promise<void> {
    const zipPath = path.join(os.tmpdir(), `bcm_${Date.now()}.zip`);
    const eZip = BcContainerService.escapePsPath(zipPath);
    const eHostDir = BcContainerService.escapePsPath(hostDir);
    const eContainerDir = BcContainerService.escapePsPath(containerDir);
    const containerZip = `${containerDir}.zip`;
    const eContainerZip = BcContainerService.escapePsPath(containerZip);

    try {
      await this.exec(
        `powershell -NoProfile -Command "Compress-Archive -Path '${eHostDir}\\*' -DestinationPath '${eZip}' -Force"`,
        60_000,
      );
      await this.execInContainer(
        containerName,
        `New-Item -Path '${eContainerDir}' -ItemType Directory -Force | Out-Null`,
        15_000,
      );
      await this.writeFileToContainer(containerName, zipPath, containerZip);
      await this.execInContainer(
        containerName,
        `Expand-Archive -Path '${eContainerZip}' -DestinationPath '${eContainerDir}' -Force; Remove-Item '${eContainerZip}' -Force -ErrorAction SilentlyContinue`,
        120_000,
      );
    } finally {
      fs.rmSync(zipPath, { force: true });
    }
  }

  // ── v1.1: Copy Container IP ──────────────────────────────────

  async copyContainerIp(containerName: string): Promise<void> {
    const ip = await this.docker.getContainerIp(containerName);
    if (!ip) {
      vscode.window.showWarningMessage(
        `Could not determine IP for "${containerName}". Is the container running?`,
      );
      return;
    }
    await vscode.env.clipboard.writeText(ip);
    vscode.window.showInformationMessage(`Container IP ${ip} copied to clipboard.`);
  }

  // ── v1.1: Publish AL App ─────────────────────────────────────

  async publishApp(containerName: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "AL App Package": ["app"] },
      title: "Select .app file to publish",
    });
    if (!uris || uris.length === 0) { return; }

    const hostPath = uris[0].fsPath;
    const fileName = path.basename(hostPath);
    const containerPath = `${CONTAINER_TEMP}\\${fileName}`;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Publishing ${fileName}…` },
      async (progress) => {
        // Step 1: Prepare container + fetch metadata in parallel
        progress.report({ message: "Preparing…" });
        const [serverInstance] = await Promise.all([
          this.getServerInstance(containerName),
          this.execInContainer(
            containerName,
            `if (!(Test-Path '${CONTAINER_TEMP}')) { New-Item -Path '${CONTAINER_TEMP}' -ItemType Directory -Force | Out-Null }`,
          ),
        ]);

        // Step 2: Copy .app file into container
        progress.report({ message: "Copying app to container..." });
        await this.writeFileToContainer(containerName, hostPath, containerPath);

        // Step 3: Publish the app
        progress.report({ message: "Publishing app…" });
        const publishCmd = [
          `Publish-NAVApp`,
          `-ServerInstance '${serverInstance}'`,
          `-Path '${containerPath}'`,
          `-SkipVerification`,
        ].join(" ");
        await this.execNavInContainer(containerName, publishCmd, 300_000);

        // Step 4: Sync and install
        progress.report({ message: "Syncing & installing…" });
        const appInfo = await this.execNavInContainer(
          containerName,
          `Get-NAVAppInfo -Path '${containerPath}' | ConvertTo-Json -Depth 1`,
        );
        try {
          const info = JSON.parse(appInfo);
          const appName = info.Name || info.name;
          const appVersion = info.Version || info.version;
          if (appName && appVersion) {
            await this.execNavInContainer(
              containerName,
              `Sync-NAVApp -ServerInstance '${serverInstance}' -Name '${appName}' -Version '${appVersion}' -Mode ForceSync`,
              120_000,
            );
            // Try install, but it may already be installed (upgrade case)
            try {
              await this.execNavInContainer(
                containerName,
                `Install-NAVApp -ServerInstance '${serverInstance}' -Name '${appName}' -Version '${appVersion}' -Force`,
                120_000,
              );
            } catch {
              // If install fails, try Start-NAVAppDataUpgrade for upgrades
              try {
                await this.execNavInContainer(
                  containerName,
                  `Start-NAVAppDataUpgrade -ServerInstance '${serverInstance}' -Name '${appName}' -Version '${appVersion}' -Force`,
                  120_000,
                );
              } catch {
                // App may already be the latest — that's fine
              }
            }
          }
        } catch {
          // Could not parse app info — publish succeeded, user can sync manually
        }

        // Step 6: Cleanup
        await this.execInContainer(
          containerName,
          `Remove-Item -Path '${containerPath}' -Force -ErrorAction SilentlyContinue`,
        ).catch(() => {});

        vscode.window.showInformationMessage(`App "${fileName}" published to "${containerName}".`);
      },
    );
  }

  // ── v1.1: Upload License ─────────────────────────────────────

  async uploadLicense(containerName: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "BC License": ["flf", "bclicense"] },
      title: "Select license file to import",
    });
    if (!uris || uris.length === 0) { return; }

    const hostPath = uris[0].fsPath;
    const fileName = path.basename(hostPath);
    const containerPath = `${CONTAINER_TEMP}\\${fileName}`;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Importing license…" },
      async (progress) => {
        progress.report({ message: "Copying license to container..." });
        await this.execInContainer(
          containerName,
          `if (!(Test-Path '${CONTAINER_TEMP}')) { New-Item -Path '${CONTAINER_TEMP}' -ItemType Directory -Force | Out-Null }`,
        );
        await this.writeFileToContainer(containerName, hostPath, containerPath);

        const serverInstance = await this.getServerInstance(containerName);

        progress.report({ message: "Importing license…" });
        await this.execNavInContainer(
          containerName,
          `Import-NAVServerLicense -ServerInstance '${serverInstance}' -LicenseFile '${containerPath}' -Database NavDatabase -Force`,
          60_000,
        );

        progress.report({ message: "Restarting service tier…" });
        await this.execNavInContainer(
          containerName,
          `Restart-NAVServerInstance -ServerInstance '${serverInstance}' -Force`,
          120_000,
        );

        // Cleanup
        await this.execInContainer(
          containerName,
          `Remove-Item -Path '${containerPath}' -Force -ErrorAction SilentlyContinue`,
        ).catch(() => {});

        vscode.window.showInformationMessage(
          `License imported and service restarted on "${containerName}".`,
        );
      },
    );
  }

  // ── v1.2: User Management ────────────────────────────────────

  async addUser(containerName: string): Promise<void> {
    const username = await vscode.window.showInputBox({
      title: "Add BC User — Username",
      prompt: "Enter the username for the new BC user",
      placeHolder: "testuser",
    });
    if (!username) { return; }

    const password = await vscode.window.showInputBox({
      title: "Add BC User — Password",
      prompt: "Enter the password",
      password: true,
    });
    if (!password) { return; }

    const permissionSet = await vscode.window.showQuickPick(
      ["SUPER", "D365 FULL ACCESS", "D365 BUS FULL ACCESS", "D365 BASIC", "D365 TEAM MEMBER", "SECURITY"],
      { title: "Permission Set", placeHolder: "Select permission set to assign" },
    );
    if (!permissionSet) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Adding user "${username}"…` },
      async () => {
        const serverInstance = await this.getServerInstance(containerName);
        await this.execNavInContainer(
          containerName,
          [
            `$pw = ConvertTo-SecureString '${password.replace(/'/g, "''")}' -AsPlainText -Force;`,
            `New-NAVServerUser -ServerInstance '${serverInstance}' -UserName '${username}' -Password $pw -FullName '${username}' -State Enabled;`,
            `New-NAVServerUserPermissionSet -ServerInstance '${serverInstance}' -UserName '${username}' -PermissionSetId '${permissionSet}'`,
          ].join(" "),
        );
        vscode.window.showInformationMessage(
          `User "${username}" added with ${permissionSet} permissions.`,
        );
      },
    );
  }

  async addTestUsers(containerName: string): Promise<void> {
    const confirm = await vscode.window.showInformationMessage(
      "This will create standard test users:\n• ESSENTIAL (SUPER)\n• PREMIUM (SUPER)\n• TEAMMEMBER (D365 TEAM MEMBER)\n\nAll with password P@ssw0rd",
      { modal: true },
      "Create Test Users",
    );
    if (confirm !== "Create Test Users") { return; }

    const testUsers = [
      { name: "ESSENTIAL", permission: "SUPER" },
      { name: "PREMIUM", permission: "SUPER" },
      { name: "TEAMMEMBER", permission: "D365 TEAM MEMBER" },
    ];

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating test users…" },
      async (progress) => {
        const serverInstance = await this.getServerInstance(containerName);
        for (const user of testUsers) {
          progress.report({ message: `Creating ${user.name}…` });
          try {
            await this.execNavInContainer(
              containerName,
              [
                `$pw = ConvertTo-SecureString 'P@ssw0rd' -AsPlainText -Force;`,
                `New-NAVServerUser -ServerInstance '${serverInstance}' -UserName '${user.name}' -Password $pw -FullName '${user.name}' -State Enabled -ErrorAction Stop;`,
                `New-NAVServerUserPermissionSet -ServerInstance '${serverInstance}' -UserName '${user.name}' -PermissionSetId '${user.permission}'`,
              ].join(" "),
            );
          } catch {
            // User may already exist — continue
          }
        }
        vscode.window.showInformationMessage(
          `Test users created on "${containerName}" (password: P@ssw0rd).`,
        );
      },
    );
  }

  // ── v1.2: Database Backup & Restore ──────────────────────────

  async backupDatabase(containerName: string): Promise<void> {
    const saveUri = await vscode.window.showSaveDialog({
      filters: { "Database Backup": ["bak"] },
      defaultUri: vscode.Uri.file(
        path.join(os.homedir(), `${containerName}_backup.bak`),
      ),
      title: "Save database backup as…",
    });
    if (!saveUri) { return; }

    const containerBakPath = `C:\\temp\\${containerName}_backup.bak`;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Backing up database…" },
      async (progress) => {
        progress.report({ message: "Creating backup inside container…" });
        const { serverInstance, dbName } = await this.getContainerInfo(containerName);

        await this.execInContainer(
          containerName,
          [
            `New-Item -Path 'C:\\temp' -ItemType Directory -Force -ErrorAction SilentlyContinue | Out-Null;`,
            `Invoke-Sqlcmd -Query "BACKUP DATABASE [${dbName}] TO DISK='${containerBakPath}' WITH FORMAT, COMPRESSION"`,
          ].join(" "),
          600_000, // 10 min timeout for large DBs
        );

        progress.report({ message: "Copying backup to host..." });
        await this.readFileFromContainer(containerName, containerBakPath, saveUri.fsPath);

        // Cleanup inside container
        await this.execInContainer(
          containerName,
          `Remove-Item -Path '${containerBakPath}' -Force -ErrorAction SilentlyContinue`,
        ).catch(() => {});

        vscode.window.showInformationMessage(
          `Database backup saved to ${saveUri.fsPath}`,
        );
      },
    );
  }

  async restoreDatabase(containerName: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Database Backup": ["bak"] },
      title: "Select .bak file to restore",
    });
    if (!uris || uris.length === 0) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Restore will REPLACE the current database in "${containerName}". This cannot be undone.`,
      { modal: true },
      "Restore",
    );
    if (confirm !== "Restore") { return; }

    const hostPath = uris[0].fsPath;
    const containerBakPath = `C:\\temp\\restore_${Date.now()}.bak`;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Restoring database…" },
      async (progress) => {
        // Fetch container metadata + prepare temp dir in parallel
        const [{ serverInstance, dbName }] = await Promise.all([
          this.getContainerInfo(containerName),
          this.execInContainer(
            containerName,
            `New-Item -Path 'C:\\temp' -ItemType Directory -Force -ErrorAction SilentlyContinue | Out-Null`,
          ),
        ]);

        progress.report({ message: "Copying backup to container..." });
        await this.writeFileToContainer(containerName, hostPath, containerBakPath);

        progress.report({ message: "Stopping service tier…" });
        await this.execNavInContainer(
          containerName,
          `Set-NAVServerInstance -ServerInstance '${serverInstance}' -Stop`,
          60_000,
        );

        progress.report({ message: "Restoring database…" });
        await this.execInContainer(
          containerName,
          `Invoke-Sqlcmd -Query "ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; RESTORE DATABASE [${dbName}] FROM DISK='${containerBakPath}' WITH REPLACE; ALTER DATABASE [${dbName}] SET MULTI_USER"`,
          600_000,
        );

        progress.report({ message: "Starting service tier…" });
        await this.execNavInContainer(
          containerName,
          `Set-NAVServerInstance -ServerInstance '${serverInstance}' -Start`,
          120_000,
        );

        // Cleanup
        await this.execInContainer(
          containerName,
          `Remove-Item -Path '${containerBakPath}' -Force -ErrorAction SilentlyContinue`,
        ).catch(() => {});

        vscode.window.showInformationMessage(
          `Database restored on "${containerName}".`,
        );
      },
    );
  }

  // ── v1.2: Install Test Toolkit ───────────────────────────────

  async installTestToolkit(containerName: string): Promise<void> {
    const includeTestLibs = await vscode.window.showQuickPick(
      [
        { label: "Test Framework Only", description: "Core test framework libraries", value: "framework" },
        { label: "Full Test Toolkit", description: "Framework + all test apps", value: "full" },
      ],
      { title: "Test Toolkit Scope", placeHolder: "Select what to install" },
    );
    if (!includeTestLibs) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Test Toolkit…" },
      async (progress) => {
        const serverInstance = await this.getServerInstance(containerName);

        // Find test toolkit apps inside the container
        progress.report({ message: "Finding test toolkit apps…" });
        const appsJson = await this.execInContainer(
          containerName,
          [
            `$testAppsPath = 'C:\\TestToolkit';`,
            `if (!(Test-Path $testAppsPath)) { $testAppsPath = Get-ChildItem 'C:\\Applications\\TestToolkit' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }`,
            `if (!(Test-Path $testAppsPath)) { throw 'Test Toolkit apps not found in container' }`,
            `Get-ChildItem $testAppsPath -Filter *.app | Select-Object Name, FullName | ConvertTo-Json -Depth 1`,
          ].join(" "),
          30_000,
        );

        let apps: { Name: string; FullName: string }[];
        try {
          const parsed = JSON.parse(appsJson);
          apps = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          throw new Error("Could not find test toolkit apps in container.");
        }

        // Filter to framework-only if requested
        const frameworkApps = [
          "Microsoft_Any",
          "Microsoft_Library Assert",
          "Microsoft_Test Runner",
          "Microsoft_Library Variable Storage",
          "Microsoft_System Application Test Library",
          "Microsoft_Tests-TestLibraries",
        ];

        if (includeTestLibs.value === "framework") {
          apps = apps.filter((a) =>
            frameworkApps.some((f) => a.Name.startsWith(f)),
          );
        }

        // Publish each app
        let published = 0;
        for (const app of apps) {
          progress.report({ message: `Publishing ${app.Name} (${++published}/${apps.length})…` });
          try {
            await this.execNavInContainer(
              containerName,
              `Publish-NAVApp -ServerInstance '${serverInstance}' -Path '${app.FullName}' -SkipVerification -Install`,
              120_000,
            );
          } catch {
            // Some apps may have dependency issues — continue
          }
        }

        vscode.window.showInformationMessage(
          `Test Toolkit installed (${published} apps) on "${containerName}".`,
        );
      },
    );
  }

  // ── v1.3: Container Resource Monitor ─────────────────────────

  async getContainerStats(containerName: string): Promise<string> {
    const raw = await this.exec(
      `docker stats ${containerName} --no-stream --format "{{json .}}"`,
      10_000,
    );
    return raw.trim();
  }

  async showContainerStats(containerName: string): Promise<void> {
    const output = vscode.window.createOutputChannel(`Stats: ${containerName}`);
    output.show();
    output.appendLine(`Resource monitor for "${containerName}" — refreshing every 5s…`);
    output.appendLine("─".repeat(80));

    const refresh = async () => {
      try {
        const raw = await this.getContainerStats(containerName);
        const stats = JSON.parse(raw);
        const line = [
          `[${new Date().toLocaleTimeString()}]`,
          `CPU: ${stats.CPUPerc}`,
          `MEM: ${stats.MemUsage} (${stats.MemPerc})`,
          `NET: ${stats.NetIO}`,
          `DISK: ${stats.BlockIO}`,
        ].join("  |  ");
        output.appendLine(line);
      } catch {
        output.appendLine(`[${new Date().toLocaleTimeString()}]  Container not responding`);
      }
    };

    // Initial refresh
    await refresh();

    // Set up polling — runs until output channel is disposed
    const interval = setInterval(refresh, 5000);
    const origDispose = output.dispose.bind(output);
    output.dispose = () => {
      clearInterval(interval);
      origDispose();
    };
  }

  // ── v1.3: Edit NST Settings ──────────────────────────────────

  async editNstSettings(containerName: string): Promise<void> {
    const serverInstance = await this.getServerInstance(containerName);

    const raw = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Reading NST settings…" },
      async () => {
        return await this.execNavInContainer(
          containerName,
          `Get-NAVServerConfiguration -ServerInstance '${serverInstance}' | Select-Object KeyName, Value | ConvertTo-Json -Depth 1`,
          30_000,
        );
      },
    );

    let settings: { KeyName: string; Value: string }[];
    try {
      settings = JSON.parse(raw);
      if (!Array.isArray(settings)) { settings = [settings]; }
    } catch {
      throw new Error("Could not read NST settings.");
    }

    // Show quick pick to select a setting to edit
    const items = settings.map((s) => ({
      label: s.KeyName,
      description: s.Value || "(empty)",
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `NST Settings — ${containerName}`,
      placeHolder: "Select a setting to edit",
      matchOnDescription: true,
    });
    if (!selected) { return; }

    const current = settings.find((s) => s.KeyName === selected.label);
    const newValue = await vscode.window.showInputBox({
      title: `Edit ${selected.label}`,
      prompt: `Current value: ${current?.Value || "(empty)"}`,
      value: current?.Value || "",
    });
    if (newValue === undefined) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating ${selected.label}…` },
      async () => {
        await this.execNavInContainer(
          containerName,
          `Set-NAVServerConfiguration -ServerInstance '${serverInstance}' -KeyName '${selected.label}' -KeyValue '${newValue.replace(/'/g, "''")}'`,
        );

        const restart = await vscode.window.showInformationMessage(
          `Setting "${selected.label}" updated. Restart the service tier for it to take effect?`,
          "Restart Now",
          "Later",
        );
        if (restart === "Restart Now") {
          await this.execNavInContainer(
            containerName,
            `Restart-NAVServerInstance -ServerInstance '${serverInstance}' -Force`,
            120_000,
          );
          vscode.window.showInformationMessage("Service tier restarted.");
        }
      },
    );
  }

  // ── v1.3: Container Event Log ────────────────────────────────

  async viewEventLog(containerName: string): Promise<void> {
    const count = await vscode.window.showQuickPick(
      ["50", "100", "200", "500"],
      { title: "How many recent entries?", placeHolder: "Select number of log entries" },
    );
    if (!count) { return; }

    const output = vscode.window.createOutputChannel(`Events: ${containerName}`);
    output.show();

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Fetching event log…" },
      async () => {
        const raw = await this.execInContainer(
          containerName,
          [
            `Get-EventLog -LogName Application -Newest ${count}`,
            `-ErrorAction SilentlyContinue`,
            `| Where-Object { $_.Source -like 'MicrosoftDynamicsNavServer*' -or $_.Source -like 'MSSQL*' }`,
            `| Format-Table -AutoSize -Wrap TimeGenerated, EntryType, Source, Message`,
            `| Out-String -Width 200`,
          ].join(" "),
          60_000,
        );
        output.appendLine(`Event Log — ${containerName} (last ${count} BC/SQL entries)`);
        output.appendLine("═".repeat(120));
        output.appendLine(raw || "No matching event log entries found.");
      },
    );
  }

  // ── v1.3: Container Profiles ─────────────────────────────────

  private _profileStoragePath: string = "";

  setProfileStoragePath(storagePath: string): void {
    this._profileStoragePath = storagePath;
  }

  private get profileFilePath(): string {
    return path.join(this._profileStoragePath, "container-profiles.json");
  }

  private loadProfiles(): Record<string, ContainerProfile> {
    try {
      if (fs.existsSync(this.profileFilePath)) {
        return JSON.parse(fs.readFileSync(this.profileFilePath, "utf-8"));
      }
    } catch { /* ignore */ }
    return {};
  }

  private saveProfiles(profiles: Record<string, ContainerProfile>): void {
    const dir = path.dirname(this.profileFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.profileFilePath, JSON.stringify(profiles, null, 2), "utf-8");
  }

  async saveProfile(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "Save Container Profile",
      prompt: "Enter a name for this profile",
      placeHolder: "my-bc25-setup",
    });
    if (!name) { return; }

    const config = vscode.workspace.getConfiguration("bcDockerManager");
    const profile: ContainerProfile = {
      name,
      memoryLimit: config.get("defaultMemory", "8G"),
      isolation: config.get("defaultIsolation", "hyperv"),
      auth: config.get("defaultAuth", "UserPassword"),
      dns: config.get("defaultDns", "8.8.8.8"),
      createdAt: new Date().toISOString(),
    };

    // Ask for optional overrides
    const country = await vscode.window.showInputBox({
      title: "Default Country",
      prompt: "Country code (leave empty to skip)",
      placeHolder: "us",
    });
    if (country) { profile.country = country; }

    const license = await vscode.window.showInputBox({
      title: "License Path",
      prompt: "Path to license file (leave empty to skip)",
    });
    if (license) { profile.licensePath = license; }

    const profiles = this.loadProfiles();
    profiles[name] = profile;
    this.saveProfiles(profiles);

    vscode.window.showInformationMessage(`Profile "${name}" saved.`);
  }

  async loadProfile(): Promise<ContainerProfile | undefined> {
    const profiles = this.loadProfiles();
    const keys = Object.keys(profiles);
    if (keys.length === 0) {
      vscode.window.showInformationMessage("No saved profiles. Use 'Save Container Profile' first.");
      return undefined;
    }

    const items = keys.map((k) => ({
      label: profiles[k].name,
      description: `${profiles[k].isolation} | ${profiles[k].memoryLimit} | ${profiles[k].auth}`,
      detail: profiles[k].country ? `Country: ${profiles[k].country}` : undefined,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: "Load Container Profile",
      placeHolder: "Select a saved profile",
    });
    if (!selected) { return undefined; }

    const profile = profiles[selected.label];
    vscode.window.showInformationMessage(`Profile "${selected.label}" loaded.`);
    return profile;
  }

  async deleteProfile(): Promise<void> {
    const profiles = this.loadProfiles();
    const keys = Object.keys(profiles);
    if (keys.length === 0) {
      vscode.window.showInformationMessage("No saved profiles.");
      return;
    }

    const selected = await vscode.window.showQuickPick(
      keys.map((k) => ({ label: profiles[k].name })),
      { title: "Delete Container Profile", placeHolder: "Select profile to delete" },
    );
    if (!selected) { return; }

    delete profiles[selected.label];
    this.saveProfiles(profiles);
    vscode.window.showInformationMessage(`Profile "${selected.label}" deleted.`);
  }

  // ── v1.4: Compile AL App ─────────────────────────────────────

  async compileApp(containerName: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage("No workspace folder open.");
      return;
    }

    const targetFolder = folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select AL project folder" });
    if (!targetFolder) { return; }

    const appJsonPath = path.join(targetFolder.uri.fsPath, "app.json");
    if (!fs.existsSync(appJsonPath)) {
      vscode.window.showWarningMessage("No app.json found in the selected folder.");
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Compiling AL app…" },
      async (progress) => {
        const serverInstance = await this.getServerInstance(containerName);
        progress.report({ message: "Locating AL compiler…" });
        const alcPath = await this.execInContainer(
          containerName,
          `Get-ChildItem 'C:\\Run' -Recurse -Filter 'alc.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`,
          15_000,
        );
        if (!alcPath.trim()) {
          throw new Error("AL compiler (alc.exe) not found in container.");
        }

        // Copy workspace to container
        progress.report({ message: "Copying project to container..." });
        const containerProjectPath = `C:\\temp\\alproject_${Date.now()}`;
        await this.writeDirToContainer(containerName, targetFolder.uri.fsPath, containerProjectPath);

        // Find symbol files
        const symbolPath = await this.execInContainer(
          containerName,
          `$p = Get-ChildItem 'C:\\Run\\*.app' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty DirectoryName; if ($p) { $p } else { 'C:\\Run' }`,
          15_000,
        );

        // Compile
        progress.report({ message: "Compiling…" });
        const output = vscode.window.createOutputChannel(`Compile: ${containerName}`);
        output.show();

        const result = await this.execInContainer(
          containerName,
          `& '${alcPath.trim()}' /project:'${containerProjectPath}' /packagecachepath:'${symbolPath.trim()}' /out:'${containerProjectPath}\\output.app' 2>&1`,
          300_000,
        );
        output.appendLine(result);

        // Check if output .app was created
        const outputExists = await this.execInContainer(
          containerName,
          `Test-Path '${containerProjectPath}\\output.app'`,
          10_000,
        );

        if (outputExists.trim().toLowerCase() === "true") {
          // Copy back to host
          progress.report({ message: "Copying compiled app to host..." });
          const outputPath = path.join(targetFolder.uri.fsPath, "output.app");
          await this.readFileFromContainer(containerName, `${containerProjectPath}\\output.app`, outputPath);
          vscode.window.showInformationMessage(`Compiled app saved to ${outputPath}`);
        } else {
          vscode.window.showWarningMessage("Compilation completed with errors. Check the output channel.");
        }

        // Cleanup
        await this.execInContainer(
          containerName,
          `Remove-Item -Path '${containerProjectPath}' -Recurse -Force -ErrorAction SilentlyContinue`,
        ).catch(() => {});
      },
    );
  }

  // ── v1.4: Container Export/Import ────────────────────────────

  async exportContainer(containerName: string): Promise<void> {
    const saveUri = await vscode.window.showSaveDialog({
      filters: { "Docker Image": ["tar"] },
      defaultUri: vscode.Uri.file(
        path.join(os.homedir(), `${containerName}.tar`),
      ),
      title: "Export container as…",
    });
    if (!saveUri) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting "${containerName}"…` },
      async (progress) => {
        progress.report({ message: "Committing container to image…" });
        const imageName = `${containerName}-export:latest`;
        await this.exec(`docker commit ${containerName} ${imageName}`, 600_000);

        progress.report({ message: "Saving image to file…" });
        await this.exec(`docker save -o "${saveUri.fsPath}" ${imageName}`, 600_000);

        // Remove the temporary image
        await this.exec(`docker rmi ${imageName}`).catch(() => {});

        vscode.window.showInformationMessage(
          `Container exported to ${saveUri.fsPath}`,
        );
      },
    );
  }

  async importContainer(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Docker Image": ["tar"] },
      title: "Select exported container (.tar) to import",
    });
    if (!uris || uris.length === 0) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Importing container…" },
      async () => {
        await this.exec(`docker load -i "${uris[0].fsPath}"`, 600_000);
        vscode.window.showInformationMessage(
          `Image imported from ${path.basename(uris[0].fsPath)}. Check Local Images.`,
        );
      },
    );
  }

  // ── v1.4: Volume Management ──────────────────────────────────

  async getVolumes(): Promise<DockerVolume[]> {
    return this._volumeCache.get("all", () => this._fetchVolumes());
  }

  private async _fetchVolumes(): Promise<DockerVolume[]> {
    const raw = await this.exec('docker volume ls --format "{{json .}}"');
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const v = JSON.parse(line);
        return {
          driver: v.Driver,
          name: v.Name,
          mountpoint: v.Mountpoint || "",
        };
      });
  }

  async createVolume(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "Create Docker Volume",
      prompt: "Enter volume name",
      placeHolder: "my-bc-data",
    });
    if (!name) { return; }
    await this.exec(`docker volume create ${name}`);
    this._volumeCache.invalidate("all");
    vscode.window.showInformationMessage(`Volume "${name}" created.`);
  }

  async removeVolume(name: string): Promise<void> {
    await this.exec(`docker volume rm ${name}`);
    this._volumeCache.invalidate("all");
  }

  async inspectVolume(name: string): Promise<void> {
    const raw = await this.exec(`docker volume inspect ${name}`);
    const doc = await vscode.workspace.openTextDocument({
      content: raw,
      language: "json",
    });
    await vscode.window.showTextDocument(doc);
  }

  // ── Helpers ──────────────────────────────────────────────────

  /** In-memory cache for container metadata to avoid repeated docker exec calls. */
  private _containerInfoCache = new Map<string, { serverInstance: string; dbName: string; ts: number }>();
  private static readonly INFO_CACHE_TTL = 60_000; // 1 minute

  /**
   * Get BC server instance name AND database name in a single docker exec call.
   * Results are cached for 1 minute to avoid repeated round-trips.
   */
  private async getContainerInfo(containerName: string): Promise<{ serverInstance: string; dbName: string }> {
    const cached = this._containerInfoCache.get(containerName);
    if (cached && Date.now() - cached.ts < BcContainerService.INFO_CACHE_TTL) {
      return { serverInstance: cached.serverInstance, dbName: cached.dbName };
    }

    try {
      const raw = await this.execNavInContainer(
        containerName,
        [
          `$si = (Get-NAVServerInstance | Select-Object -First 1).ServerInstance -replace '.*\\\\$', '';`,
          `if (!$si) { $si = '${BC_SERVER_INSTANCE}' };`,
          `$db = (Get-NAVServerConfiguration -ServerInstance $si -ErrorAction SilentlyContinue | Where-Object { $_.KeyName -eq 'DatabaseName' }).Value;`,
          `if (!$db) { $db = 'CRONUS' };`,
          `ConvertTo-Json @{ ServerInstance = $si; DatabaseName = $db }`,
        ].join(" "),
        15_000,
      );
      const info = JSON.parse(raw.trim());
      const result = {
        serverInstance: info.ServerInstance || BC_SERVER_INSTANCE,
        dbName: info.DatabaseName || "CRONUS",
      };
      this._containerInfoCache.set(containerName, { ...result, ts: Date.now() });
      return result;
    } catch {
      return { serverInstance: BC_SERVER_INSTANCE, dbName: "CRONUS" };
    }
  }

  /** Shorthand — get just the server instance name. */
  private async getServerInstance(containerName: string): Promise<string> {
    return (await this.getContainerInfo(containerName)).serverInstance;
  }

  /** Shorthand — get just the database name. */
  private async getDatabaseName(
    containerName: string,
    _serverInstance?: string,
  ): Promise<string> {
    return (await this.getContainerInfo(containerName)).dbName;
  }
}

// ────────────────────────── Interfaces ──────────────────────────

export interface ContainerProfile {
  name: string;
  memoryLimit: string;
  isolation: string;
  auth: string;
  dns: string;
  country?: string;
  licensePath?: string;
  createdAt: string;
}

export interface DockerVolume {
  driver: string;
  name: string;
  mountpoint: string;
}
