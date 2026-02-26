import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ────────────────────────── Constants ───────────────────────────

/**
 * Docker Engine standalone install paths — no Docker Desktop.
 * This is where `InstallOrUpdateDockerEngine.ps1` places the binaries.
 */
const DOCKER_SEARCH_PATHS = [
  `${process.env["ProgramFiles"]}\\docker\\docker.exe`,
  `${process.env["ProgramW6432"]}\\docker\\docker.exe`,
];

const DOCKER_ENGINE_DOWNLOAD_URL =
  "https://download.docker.com/win/static/stable/x86_64/";

const DOCKER_ENGINE_DOCS_URL =
  "https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/set-up-environment";

// ────────────────────────── Service ────────────────────────────

/**
 * Docker Engine detection and guided installation.
 *
 * This extension targets Docker Engine (Windows service) only —
 * Docker Desktop is NOT needed and would conflict with the
 * standalone engine approach used by BcContainerHelper.
 */
export class DockerSetup {

  // ── detection ──────────────────────────────────────────────

  /** True if `docker` is on the system PATH. */
  static async isOnPath(): Promise<boolean> {
    return new Promise((resolve) => {
      exec("docker --version", { timeout: 5000 }, (err) => resolve(!err));
    });
  }

  /** True if Docker Desktop is installed (we want to warn about this). */
  static async isDockerDesktopInstalled(): Promise<boolean> {
    const { existsSync } = await import("fs");
    const paths = [
      `${process.env["ProgramFiles"]}\\Docker Desktop`,
      `${process.env["ProgramFiles"]}\\DockerDesktop`,
    ];
    return paths.some((p) => p && existsSync(p));
  }

  /** Scan common install locations for docker.exe (Engine standalone). */
  static async findDockerExe(): Promise<string | undefined> {
    // 1. Try PATH first
    const onPath = await DockerSetup.isOnPath();
    if (onPath) { return "docker"; }

    // 2. Check well-known Engine standalone locations
    const { existsSync } = await import("fs");
    for (const p of DOCKER_SEARCH_PATHS) {
      if (p && existsSync(p)) { return p; }
    }

    return undefined;
  }

  /** Check if the Docker daemon is actually running. */
  static async isDaemonRunning(dockerPath = "docker"): Promise<boolean> {
    return new Promise((resolve) => {
      exec(`"${dockerPath}" info`, { timeout: 10_000 }, (err) => resolve(!err));
    });
  }

  // ── guided setup ──────────────────────────────────────────

  /**
   * Show a wizard that guides the user through Docker Engine installation.
   * Docker Desktop is explicitly unsupported — only the standalone engine.
   * Returns true if Docker becomes available, false otherwise.
   */
  static async showSetupWizard(): Promise<boolean> {
    // Warn if Docker Desktop is present — it conflicts with standalone engine
    if (await DockerSetup.isDockerDesktopInstalled()) {
      vscode.window.showWarningMessage(
        "Docker Desktop is installed on this machine. " +
        "BC Docker Manager uses Docker Engine (Windows service) directly. " +
        "Docker Desktop may conflict — consider uninstalling it.",
      );
    }

    // Step 1: Check if Docker is actually installed but not on PATH
    const exe = await DockerSetup.findDockerExe();
    if (exe && exe !== "docker") {
      const action = await vscode.window.showInformationMessage(
        `Docker Engine was found at "${exe}" but is not on your system PATH.\n` +
          "Add the docker folder to PATH or restart VS Code.",
        "Add to PATH Now",
        "Open Docs",
        "Retry"
      );
      if (action === "Add to PATH Now") {
        await DockerSetup._addDockerToPath();
        return DockerSetup.isOnPath();
      }
      if (action === "Open Docs") {
        vscode.env.openExternal(vscode.Uri.parse(DOCKER_ENGINE_DOCS_URL));
      }
      if (action === "Retry") {
        return DockerSetup.isOnPath();
      }
      return false;
    }

    // Step 2: Docker not found at all — offer to install Engine
    const action = await vscode.window.showWarningMessage(
      "Docker Engine is required to run Business Central containers.\n\n" +
        "This will install Docker Engine as a Windows service (no Docker Desktop needed).",
      { modal: true },
      "Install Docker Engine Now",
      "Open Install Guide",
      "I Already Have Docker"
    );

    switch (action) {
      case "Install Docker Engine Now":
        return DockerSetup.installDockerEngine();

      case "Open Install Guide":
        vscode.env.openExternal(vscode.Uri.parse(DOCKER_ENGINE_DOCS_URL));
        vscode.window.showInformationMessage(
          "After installing Docker Engine, restart your computer and " +
            "reload VS Code. Then try again."
        );
        return false;

      case "I Already Have Docker": {
        const customPath = await vscode.window.showInputBox({
          prompt: "Enter the full path to docker.exe",
          placeHolder: `${process.env["ProgramFiles"]}\\docker\\docker.exe`,
          validateInput: (value) => {
            if (!value.trim()) { return "Path cannot be empty"; }
            return undefined;
          },
        });
        if (customPath) {
          const running = await DockerSetup.isDaemonRunning(customPath.trim());
          if (running) {
            vscode.window.showInformationMessage("Docker Engine is available! You're all set.");
            return true;
          }
          vscode.window.showWarningMessage(
            "Could not connect to Docker at that path. " +
              "Make sure the Docker service is running: `net start docker` (elevated prompt)."
          );
        }
        return false;
      }

      default:
        return false;
    }
  }

  /**
   * Ensure Docker is available. If not, run the setup wizard.
   * Returns the path to docker, or undefined if not available.
   */
  static async ensureDocker(): Promise<string | undefined> {
    const exe = await DockerSetup.findDockerExe();
    if (exe) {
      const running = await DockerSetup.isDaemonRunning(exe);
      if (running) { return exe; }

      // Docker found but daemon not running
      const action = await vscode.window.showWarningMessage(
        "Docker Engine is installed but the service is not running.\n" +
          "Start it with: `net start docker` (requires elevation).",
        "Start Docker Service",
        "Retry",
        "Open Docs"
      );
      if (action === "Start Docker Service") {
        // Attempt to start via elevated prompt
        await DockerSetup._startDockerService();
        // Wait a bit then check
        await new Promise((r) => setTimeout(r, 5000));
        const nowRunning = await DockerSetup.isDaemonRunning(exe);
        return nowRunning ? exe : undefined;
      }
      if (action === "Retry") {
        const nowRunning = await DockerSetup.isDaemonRunning(exe);
        return nowRunning ? exe : undefined;
      }
      if (action === "Open Docs") {
        vscode.env.openExternal(vscode.Uri.parse(DOCKER_ENGINE_DOCS_URL));
      }
      return undefined;
    }

    // No Docker at all — run wizard
    const installed = await DockerSetup.showSetupWizard();
    return installed ? "docker" : undefined;
  }

  // ── Docker Engine installer ───────────────────────────────

  /**
   * Install Docker Engine as a Windows service.
   * Mirrors the logic from InstallOrUpdateDockerEngine.ps1:
   *  1. Download latest stable zip from download.docker.com
   *  2. Extract to Program Files\docker
   *  3. Add to PATH
   *  4. Register dockerd as a Windows service
   *  5. Start the service
   *
   * Writes the install script to a temp file, then runs it elevated
   * via Start-Process -Verb RunAs to avoid quoting/escaping hell.
   */
  static async installDockerEngine(): Promise<boolean> {
    // Guard: if Docker is already installed and the daemon is responding,
    // don't silently re-download — ask the user first.
    const alreadyRunning = await DockerSetup.isDaemonRunning();
    if (alreadyRunning) {
      const action = await vscode.window.showInformationMessage(
        "Docker Engine is already installed and running.",
        "Reinstall / Update",
        "Cancel",
      );
      if (action !== "Reinstall / Update") {
        return true; // Already healthy — treat as success
      }
    }

    // Warn about Docker Desktop but DO NOT block — bcnavappcontainer works
    // with Docker Desktop too, so let the user decide.
    if (await DockerSetup.isDockerDesktopInstalled()) {
      const action = await vscode.window.showWarningMessage(
        "Docker Desktop is installed on this machine.\n\n" +
        "bcnavappcontainer (BcContainerHelper) works with Docker Desktop — " +
        "you may not need to install Docker Engine standalone.\n\n" +
        "Install Docker Engine standalone anyway?",
        { modal: true },
        "Install Anyway",
        "Cancel",
      );
      if (action !== "Install Anyway") {
        return false;
      }
    }

    const timestamp = Date.now();
    const markerFile = path.join(os.tmpdir(), `bc-docker-result-${timestamp}.txt`);

    // ── PowerShell install script (runs elevated) ──────────────
    // Self-contained: uses Moby GitHub Releases API to find the
    // latest Docker Engine version, downloads from Docker's CDN,
    // extracts, registers the service, and starts it.
    // No dependency on navcontainerhelper or any external PS scripts.
    const psScript = `
$ErrorActionPreference = 'Stop'
$markerFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'bc-docker-result-${timestamp}.txt')
try {

# ── Step 1: Enable Windows Containers feature if needed ──
$restartNeeded = $false
$feature = Get-WindowsOptionalFeature -FeatureName Containers -Online
if ($feature.State -ne 'Enabled') {
    Write-Host 'Enabling Windows Containers feature...'
    $result = Enable-WindowsOptionalFeature -FeatureName Containers -Online -NoRestart
    $restartNeeded = $result.RestartNeeded
}

# ── Step 2: Find latest Docker Engine version via Moby GitHub Releases API ──
Write-Host 'Querying latest Docker Engine version...'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/moby/moby/releases/latest'
# tag_name can be "v27.5.1" or "docker-v29.2.1" — extract the bare version
$tag = $release.tag_name -replace '^(docker-)?v', ''
Write-Host "Latest Docker Engine version: $tag"

# ── Step 3: Download from Docker CDN ──
$url = "https://download.docker.com/win/static/stable/x86_64/docker-$tag.zip"
Write-Host "Downloading $url ..."
$zipFile = Join-Path ([IO.Path]::GetTempPath()) "docker-$tag.zip"
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipFile

# ── Step 4: Extract to Program Files ──
Write-Host 'Extracting...'
$dockerDir = Join-Path $env:ProgramFiles 'docker'

# Stop existing service before overwriting binaries
$svc = Get-Service docker -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Host 'Stopping existing Docker service...'
    Stop-Service docker -Force
    Start-Sleep 2
}

Expand-Archive $zipFile -DestinationPath $env:ProgramFiles -Force
Remove-Item $zipFile -Force

# ── Step 5: Add to PATH if not already there ──
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
if ((";$machinePath;" -notlike "*;$dockerDir;*") -and (";$userPath;" -notlike "*;$dockerDir;*")) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dockerDir", 'User')
    Write-Host 'Added docker to user PATH'
}

# ── Step 6: Register Windows service if not yet registered ──
$svc = Get-Service docker -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host 'Registering Docker service...'
    & (Join-Path $dockerDir 'dockerd.exe') --register-service
}

# ── Step 7: Create panic log directory ──
New-Item 'C:\\ProgramData\\Docker' -ItemType Directory -ErrorAction SilentlyContinue | Out-Null
Remove-Item 'C:\\ProgramData\\Docker\\panic.log' -Force -ErrorAction SilentlyContinue
New-Item 'C:\\ProgramData\\Docker\\panic.log' -ItemType File -ErrorAction SilentlyContinue | Out-Null

# ── Step 8: Start service ──
if (-not $restartNeeded) {
    Write-Host 'Starting Docker service...'
    Start-Service docker
    Write-Host "Docker Engine $tag installed and started!"
} else {
    Write-Host "Docker Engine $tag installed. A RESTART is required to start the service."
}

'SUCCESS' | Out-File -FilePath $markerFile -Encoding UTF8 -Force
Write-Host 'Done - closing in 5 seconds...'
Start-Sleep 5

} catch {
    "FAILED: $($_.Exception.Message)" | Out-File -FilePath $markerFile -Encoding UTF8 -Force
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Installation failed. Press any key to close...'
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}
`;

    // Encode the install script as base64 for -EncodedCommand.
    // This completely avoids path-quoting issues (spaces in %TEMP%, etc.).
    const encodedScript = Buffer.from(psScript, "utf16le").toString("base64");

    // Wrapper script: launches the encoded install script elevated
    // and propagates the exit code via -PassThru so we can detect
    // UAC cancellation or script errors from the non-elevated side.
    const wrapperPath = path.join(os.tmpdir(), `bc-docker-wrapper-${timestamp}.ps1`);
    const wrapperContent = [
      "$ErrorActionPreference = 'Stop'",
      "try {",
      "    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(",
      "        '-NoProfile', '-ExecutionPolicy', 'Bypass',",
      `        '-EncodedCommand', '${encodedScript}'`,
      "    )",
      "    if ($p.ExitCode -ne 0) { exit $p.ExitCode }",
      "} catch {",
      "    exit 1",
      "}",
    ].join("\n");

    try {
      fs.writeFileSync(wrapperPath, wrapperContent, "utf-8");
    } catch (writeErr) {
      throw new Error(
        `Could not create install script: ${writeErr instanceof Error ? writeErr.message : writeErr}`,
      );
    }

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Docker Engine…", cancellable: false },
      () => new Promise<boolean>((resolve) => {
        exec(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${wrapperPath}"`,
          { timeout: 300_000 },
          async (err) => {
            // Clean up temp files
            try { fs.unlinkSync(wrapperPath); } catch { /* ignore */ }

            // Read the marker file written by the elevated script
            let marker = "";
            try { marker = fs.readFileSync(markerFile, "utf-8").trim(); } catch { /* no marker */ }
            try { fs.unlinkSync(markerFile); } catch { /* ignore */ }

            // Case 1: exec failed AND no marker → UAC cancelled or script never started
            if (err && !marker) {
              vscode.window.showErrorMessage(
                "Docker Engine installation was cancelled or could not start.\n" +
                "Please accept the UAC elevation prompt when it appears.",
              );
              resolve(false);
              return;
            }

            // Case 2: marker says FAILED → script ran but hit an error
            if (marker.startsWith("FAILED:")) {
              vscode.window.showErrorMessage(
                `Docker Engine installation failed:\n${marker.substring(7).trim()}`,
              );
              resolve(false);
              return;
            }

            // Case 3: marker says SUCCESS → verify Docker is responding
            if (marker === "SUCCESS") {
              await new Promise((r) => setTimeout(r, 3000));
              const running = await DockerSetup.isDaemonRunning();
              if (running) {
                vscode.window.showInformationMessage("Docker Engine installed and running!");
                resolve(true);
              } else {
                const action = await vscode.window.showWarningMessage(
                  "Docker Engine was installed successfully but the service is not " +
                  "responding yet. A system restart may be required.",
                  "Restart Now",
                  "Later",
                );
                if (action === "Restart Now") {
                  exec('shutdown /r /t 30 /c "Restarting to complete Docker Engine installation"');
                  vscode.window.showInformationMessage("System will restart in 30 seconds.");
                }
                resolve(false);
              }
              return;
            }

            // Case 4: no marker, no exec error → unknown; check Docker anyway
            await new Promise((r) => setTimeout(r, 3000));
            const running = await DockerSetup.isDaemonRunning();
            if (running) {
              vscode.window.showInformationMessage("Docker Engine is running!");
              resolve(true);
            } else {
              vscode.window.showErrorMessage(
                "Docker Engine installation failed or was cancelled.\n" +
                "You can install manually from an elevated PowerShell.",
              );
              resolve(false);
            }
          },
        );
      }),
    );
  }

  // ── helpers ───────────────────────────────────────────────

  /** Start the Docker Windows service via an elevated prompt. */
  private static _startDockerService(): Promise<void> {
    return new Promise((resolve) => {
      const cmd =
        `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','Start-Service docker; Start-Sleep 3'`;
      exec(`powershell -NoProfile -Command "${cmd}"`, { timeout: 30_000 }, () => resolve());
    });
  }

  /** Add the Docker Engine directory to the user PATH. */
  private static _addDockerToPath(): Promise<void> {
    const dockerDir = `${process.env["ProgramFiles"]}\\docker`;
    const psCmd =
      `$p = [Environment]::GetEnvironmentVariable('Path','User'); ` +
      `if (";$p;" -notlike '*;${dockerDir};*') { ` +
      `[Environment]::SetEnvironmentVariable('Path', "$p;${dockerDir}", 'User') }`;
    return new Promise((resolve) => {
      exec(
        `powershell -NoProfile -Command "${psCmd}"`,
        { timeout: 10_000 },
        () => {
          vscode.window.showInformationMessage(
            "Docker added to PATH. Restart VS Code for the change to take effect.",
          );
          resolve();
        },
      );
    });
  }
}
