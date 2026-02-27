import { exec, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// ────────────────────────── Interfaces ──────────────────────────

/** A Docker container as returned by `docker ps -a --format json`. */
export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
  /** Docker labels (key-value pairs from `docker inspect`). */
  labels: Record<string, string>;
}

/** A Docker image as returned by `docker images --format json`. */
export interface DockerImage {
  repository: string;
  tag: string;
  id: string;
  size: string;
  createdAt: string;
}

/** Enriched BC-specific metadata extracted from container labels. */
export interface BcContainerMeta {
  version: string;
  country: string;
  platform: string;
  maintainer: string;
}

/** Options for creating a BC container natively via `docker run`. */
export interface BcContainerOptions {
  containerName: string;
  artifactUrl: string;
  username: string;
  password: string;
  memoryLimit?: string;             // e.g. "8G"  (default: "4G")
  auth?: string;                    // e.g. "UserPassword" (default)
  isolation?: "hyperv" | "process"; // default: "hyperv"
  licensePath?: string;             // URL or UNC path to .bclicense
  imageName?: string;               // override the BCR image tag
  accept_eula?: boolean;            // default: true
  accept_outdated?: boolean;        // default: false
  updateHosts?: boolean;            // add container to Windows hosts file
}

// ────────────────────────── Constants ───────────────────────────

/** Max time (ms) to wait for any single Docker CLI call. */
const EXEC_TIMEOUT_MS = 30_000;

/** The official MCR Business Central generic image. */
const BC_IMAGE = "mcr.microsoft.com/businesscentral:ltsc2022";

// ────────────────────────── Service ────────────────────────────

/**
 * Pure Docker CLI wrapper. No PowerShell modules, no external
 * frameworks — just `docker` commands parsed from JSON output.
 */
export class DockerService {

  /** True if the last ensureNetworking() call actually ran a fix (UAC elevation). */
  private _networkingJustRan = false;

  /** Check if the last ensureNetworking() call performed a fix. Resets the flag. */
  async didNetworkingJustRun(): Promise<boolean> {
    const ran = this._networkingJustRan;
    this._networkingJustRan = false;
    return ran;
  }

  // ── shell helper ─────────────────────────────────────────────

  /** Run a command and resolve with its stdout (rejects on error). */
  private exec(command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  // ── health checks ───────────────────────────────────────────

  async isDockerInstalled(): Promise<boolean> {
    try { await this.exec("docker --version"); return true; }
    catch { return false; }
  }

  async isDockerRunning(): Promise<boolean> {
    try { await this.exec("docker info"); return true; }
    catch { return false; }
  }

  // ── containers ──────────────────────────────────────────────

  /** List every container (running + stopped). */
  async getContainers(): Promise<DockerContainer[]> {
    const raw = await this.exec(
      'docker ps -a --no-trunc --format "{{json .}}"'
    );
    const containers = this.parseLines(raw);

    // Fetch labels via `docker inspect` for all containers at once
    if (containers.length > 0) {
      await this.enrichWithLabels(containers);
    }
    return containers;
  }

  /**
   * List only Business Central containers.
   *
   * Detection strategy (same as the official BcContainerHelper):
   *  1. `docker ps --filter "label=nav"` — every official BC image
   *     sets a `nav` label with the BC version string.
   *  2. Fallback: image-name heuristic (matches "businesscentral"
   *     anywhere in the name, or "bc" as a delimited segment).
   */
  async getBcContainers(): Promise<DockerContainer[]> {
    // Primary: Docker label filter
    const raw = await this.exec(
      'docker ps -a --no-trunc --filter "label=nav" --format "{{json .}}"'
    );
    let containers = this.parseLines(raw);

    // Fallback: image name heuristic when no labelled containers found
    if (containers.length === 0) {
      const all = await this.exec(
        'docker ps -a --no-trunc --format "{{json .}}"'
      );
      containers = this.parseLines(all).filter(
        (c) => this.looksLikeBcImage(c.image)
      );
    }

    if (containers.length > 0) {
      await this.enrichWithLabels(containers);
    }
    return containers;
  }

  async startContainer(id: string): Promise<void> {
    await this.exec(`docker start ${id}`);
  }

  async stopContainer(id: string): Promise<void> {
    await this.exec(`docker stop ${id}`);
  }

  async restartContainer(id: string): Promise<void> {
    await this.exec(`docker restart ${id}`);
  }

  async removeContainer(id: string): Promise<void> {
    await this.exec(`docker rm -f ${id}`);
  }

  // ── images ──────────────────────────────────────────────────

  /** List all locally available Docker images. */
  async getImages(): Promise<DockerImage[]> {
    const raw = await this.exec(
      'docker images --no-trunc --format "{{json .}}"'
    );
    return this.parseImageLines(raw);
  }

  /** List only BC-related Docker images. */
  async getBcImages(): Promise<DockerImage[]> {
    const all = await this.getImages();
    return all.filter((img) => {
      const full = img.repository === "<none>"
        ? ""
        : `${img.repository}:${img.tag}`;
      return this.looksLikeBcImage(full);
    });
  }

  async removeImage(id: string): Promise<void> {
    await this.exec(`docker rmi ${id}`);
  }

  /**
   * Pull an image from a registry.
   * @param ref Full image reference, e.g. "mcr.microsoft.com/businesscentral:ltsc2022"
   * @param dockerPath Path to docker executable (default: "docker")
   */
  async pullImage(ref: string, dockerPath = "docker"): Promise<void> {
    await this.exec(`"${dockerPath}" pull ${ref}`, 600_000);
  }

  // ── inspect / labels ────────────────────────────────────────

  /**
   * Batch-fetch labels for a list of containers via `docker inspect`.
   * Mutates each container's `labels` property in place.
   */
  private async enrichWithLabels(
    containers: DockerContainer[]
  ): Promise<void> {
    const ids = containers.map((c) => c.id).join(" ");
    try {
      const raw = await this.exec(`docker inspect ${ids}`);
      const inspected = JSON.parse(raw) as InspectResult[];
      const labelMap = new Map<string, Record<string, string>>();
      for (const entry of inspected) {
        labelMap.set(entry.Id, entry.Config?.Labels ?? {});
      }
      for (const c of containers) {
        c.labels = labelMap.get(c.id) ?? {};
      }
    } catch {
      // Non-fatal; labels will remain empty objects
    }
  }

  /**
   * Extract BC-specific metadata from a container's Docker labels.
   * Official BC images set these labels:
   *   - `maintainer` = "Dynamics SMB"
   *   - `nav`        = BC version (e.g. "25.0.12345.0")
   *   - `country`    = localisation code (e.g. "us", "w1")
   *   - `platform`   = platform version
   */
  static extractBcMeta(labels: Record<string, string>): BcContainerMeta {
    return {
      version: labels["nav"] ?? "",
      country: labels["country"] ?? "",
      platform: labels["platform"] ?? "",
      maintainer: labels["maintainer"] ?? "",
    };
  }

  /** True if the container was created from an official BC image. */
  static isBcContainer(labels: Record<string, string>): boolean {
    return labels["maintainer"] === "Dynamics SMB" || "nav" in labels;
  }

  // ── parsers ─────────────────────────────────────────────────

  private parseLines(raw: string): DockerContainer[] {
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const obj = JSON.parse(line) as Record<string, string>;
        return {
          id: obj["ID"] ?? "",
          names: obj["Names"] ?? "",
          image: obj["Image"] ?? "",
          status: obj["Status"] ?? "",
          state: obj["State"] ?? "",
          ports: obj["Ports"] ?? "",
          createdAt: obj["CreatedAt"] ?? "",
          labels: {},
        };
      });
  }

  private parseImageLines(raw: string): DockerImage[] {
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const obj = JSON.parse(line) as Record<string, string>;
        return {
          repository: obj["Repository"] ?? "",
          tag: obj["Tag"] ?? "",
          id: obj["ID"] ?? "",
          size: obj["Size"] ?? "",
          createdAt: obj["CreatedAt"] ?? "",
        };
      });
  }

  /** Heuristic: does the image name look BC-related? */
  private looksLikeBcImage(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower.includes("businesscentral")) {
      return true;
    }
    // "bc" as a delimited segment: /bc:, -bc-, _bc_, bc25us, etc.
    if (/(?:^|[\/:\-_])bc(?:[\/:\-_\d]|$)/.test(lower)) {
      return true;
    }
    return false;
  }

  // ── BC container creation (native docker run) ────────────────

  /**
   * True if the Docker daemon is in Windows containers mode.
   * Required for BC containers.
   */
  async isWindowsContainerMode(): Promise<boolean> {
    try {
      const raw = await this.exec('docker info --format "{{json .}}"', 10_000);
      return (JSON.parse(raw).OSType || "").toLowerCase() === "windows";
    } catch { return false; }
  }

  /**
   * Create a Business Central container **natively** using
   * `docker pull` + `docker run`.
   *
   * The official MCR BC image entrypoint handles:
   *  - Downloading BC artifacts from CDN
   *  - SQL Server setup
   *  - NST configuration
   *  - Web client configuration
   *  - User creation with the supplied credentials
   *
   * This replaces the need for BcContainerHelper's `New-BcContainer`.
   *
   * Runs in a VS Code terminal so the user can watch progress.
   */
  async createBcContainer(
    opts: BcContainerOptions,
    output?: vscode.OutputChannel,
  ): Promise<boolean> {
    const log = (msg: string) => output?.appendLine(msg);
    const image = opts.imageName || BC_IMAGE;

    log?.(`Creating container "${opts.containerName}"`);
    log?.(`Image:    ${image}`);
    log?.(`Artifact: ${opts.artifactUrl}`);
    log?.(`Auth:     ${opts.auth || "UserPassword"}`);
    log?.(`Memory:   ${opts.memoryLimit || "4G"}`);
    log?.(`Pull:     always (ensuring latest generic image)`);
    log?.("");

    // Build the docker run command
    const args = this.buildRunArgs(opts, image);
    const cmdLine = `docker ${args.join(" ")}`;

    // Run in a VS Code terminal for full interactive output
    const terminal = vscode.window.createTerminal({
      name: `BC: ${opts.containerName}`,
      shellPath: "powershell.exe",
      shellArgs: ["-NoProfile", "-Command", cmdLine],
    });
    terminal.show();

    log?.(`Container started — watching logs for initialization progress...`);
    log?.(`This takes 5-15 minutes (downloading artifacts, installing SQL, configuring BC).\n`);

    return true;
  }

  /**
   * Wait for a container to become healthy by polling `docker inspect`.
   * Returns true if the container becomes healthy within the timeout.
   *
   * Also streams log snippets to the output channel so the user can
   * see what phase the initialisation is in.
   */
  async waitForContainerReady(
    containerName: string,
    output?: vscode.OutputChannel,
    timeoutMs = 1_800_000,  // 30 minutes max (large artifacts can take 20+ min)
    pollMs = 10_000,        // check every 10s
  ): Promise<boolean> {
    const log = (msg: string) => output?.appendLine(msg);
    const start = Date.now();
    let lastLogLine = "";

    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));

      // Check container state + health in one shot
      try {
        const fmt = '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}';
        const raw = await this.exec(
          `docker inspect -f "${fmt}" ${containerName}`,
          10_000,
        );
        const [state, health] = raw.trim().split("|");

        if (health === "healthy") {
          log?.(`\n✓ Container "${containerName}" is ready!`);
          return true;
        }

        // Container exited before becoming healthy
        if (state === "exited" || state === "dead") {
          log?.(`\n✗ Container "${containerName}" ${state} unexpectedly.`);
          return false;
        }

        // "starting" or "unhealthy" while container is still running = keep waiting
        // "no-healthcheck" = image has no HEALTHCHECK, fall back to log-based detection
        if (health === "no-healthcheck" && state === "running") {
          // Check if the BC initialization has completed by looking for the ready marker in logs
          try {
            const tailRaw = await this.exec(
              `docker logs --tail 5 ${containerName}`,
              5_000,
            );
            if (tailRaw.includes("Ready for connections!") || tailRaw.includes("Container setup complete")) {
              log?.(`\n✓ Container "${containerName}" is ready! (detected from logs)`);
              return true;
            }
          } catch { /* ignore */ }
        }
      } catch {
        // Container might not exist yet (image still pulling)
      }

      // Stream the latest log line to show progress
      try {
        const logRaw = await this.exec(
          `docker logs --tail 1 ${containerName}`,
          5_000,
        );
        const line = logRaw.trim();
        if (line && line !== lastLogLine) {
          lastLogLine = line;
          const elapsed = Math.round((Date.now() - start) / 1000);
          log?.(`[${elapsed}s] ${line}`);
        }
      } catch { /* container may not exist yet */ }
    }

    log?.(`\n✗ Timed out waiting for "${containerName}" to become healthy (${Math.round(timeoutMs / 60_000)} min).`);
    return false;
  }

  /**
   * Build the argument list for `docker run`.
   *
   * The MCR BC image uses these env vars:
   *  - `accept_eula`      = "Y"
   *  - `accept_outdated`  = "Y" (optional)
   *  - `artifactUrl`      = full CDN artifact URL
   *  - `username`         = admin user
   *  - `password`         = admin password
   *  - `auth`             = "UserPassword" | "NavUserPassword" | "Windows"
   *  - `licenseFile`      = path/URL to .bclicense (optional)
   */
  private buildRunArgs(opts: BcContainerOptions, image: string): string[] {
    const args: string[] = [
      "run", "-d",
      "--pull", "always",
      "--name", opts.containerName,
      "--hostname", opts.containerName,
      "--memory", opts.memoryLimit || "4G",
      "--isolation", opts.isolation || "hyperv",
      // No -p port mappings: Hyper-V containers get their own NAT IP,
      // so we access them via hostname/IP directly. Publishing ports
      // would conflict when running multiple containers.
      // Environment variables recognised by the MCR BC entrypoint
      "-e", `accept_eula=${opts.accept_eula === false ? "N" : "Y"}`,
      "-e", `artifactUrl=${opts.artifactUrl}`,
      "-e", `username=${opts.username}`,
      "-e", `password=${opts.password}`,
      "-e", `auth=${opts.auth || "UserPassword"}`,
    ];

    if (opts.accept_outdated) {
      args.push("-e", "accept_outdated=Y");
    }

    if (opts.licensePath) {
      args.push("-e", `licenseFile=${opts.licensePath}`);
    }

    args.push(image);
    return args;
  }

  /**
   * Execute a command inside a running container, streaming
   * stdout/stderr to the provided output channel.
   */
  async execStreaming(
    containerId: string,
    command: string[],
    output: vscode.OutputChannel,
  ): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn("docker", ["exec", containerId, ...command]);
      child.stdout.on("data", (d: Buffer) => output.append(d.toString()));
      child.stderr.on("data", (d: Buffer) => output.append(d.toString()));
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
  }

  // ── host networking helpers ───────────────────────────────

  /**
   * Get the NAT IP address of a container.
   * With Hyper-V isolation the container gets its own IP on the nat network.
   */
  async getContainerIp(nameOrId: string): Promise<string | undefined> {
    try {
      const raw = await this.exec(
        `docker inspect -f "{{.NetworkSettings.Networks.nat.IPAddress}}" ${nameOrId}`,
        10_000,
      );
      const ip = raw.trim();
      return ip && ip !== "<no value>" ? ip : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Check if a container's hostname is in the Windows hosts file.
   */
  isInHostsFile(containerName: string): boolean {
    try {
      const hosts = fs.readFileSync(
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        "utf-8",
      );
      const pattern = new RegExp(
        `\\s${containerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
        "m",
      );
      return pattern.test(hosts);
    } catch {
      return false;
    }
  }

  /**
   * Check if a container's SSL certificate is installed in the
   * Windows Trusted Root Certification Authorities store.
   *
   * Looks for any cert with Subject = "CN=<containerName>".
   */
  async isCertInstalled(containerName: string): Promise<boolean> {
    try {
      const raw = await this.exec(
        `powershell -NoProfile -Command "` +
        `(Get-ChildItem Cert:\\LocalMachine\\Root | ` +
        `Where-Object { $_.Subject -eq 'CN=${containerName}' }).Count"`,
        10_000,
      );
      return parseInt(raw.trim(), 10) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Verify that the hosts file entry points to the container's current IP.
   * Returns false if the IP has changed (e.g. after container restart).
   */
  async isHostsIpCurrent(containerName: string): Promise<boolean> {
    const currentIp = await this.getContainerIp(containerName);
    if (!currentIp) { return false; }
    try {
      const hosts = fs.readFileSync(
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        "utf-8",
      );
      // Match a line like "172.17.x.x  containerName"
      const pattern = new RegExp(
        `^(\\S+)\\s+${containerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
        "m",
      );
      const match = hosts.match(pattern);
      return match ? match[1] === currentIp : false;
    } catch {
      return false;
    }
  }

  /**
   * Check all networking prerequisites for a container and auto-fix
   * anything that's missing. Returns true if everything is good.
   *
   * Checks:
   *  1. Hosts file has an entry with the correct IP
   *  2. SSL certificate is in the Trusted Root store
   *
   * If anything is missing, runs setupContainerNetworking() which
   * fixes everything in a single UAC prompt.
   */
  async ensureNetworking(containerName: string): Promise<boolean> {
    this._networkingJustRan = false;

    const hostsOk = this.isInHostsFile(containerName) &&
                    await this.isHostsIpCurrent(containerName);
    const certOk = await this.isCertInstalled(containerName);

    if (hostsOk && certOk) {
      return true; // Everything is already set up
    }

    // Something is missing — fix it all in one elevation
    const what: string[] = [];
    if (!hostsOk) { what.push("hosts file"); }
    if (!certOk) { what.push("SSL certificate"); }

    const ok = await this.setupContainerNetworking(containerName);
    if (ok) {
      this._networkingJustRan = true;
    } else {
      vscode.window.showWarningMessage(
        `Networking is incomplete (missing: ${what.join(" + ")}). ` +
        `You can fix this from the container's context menu.`,
      );
    }
    return ok;
  }

  /**
   * Add / update the container’s hostname in the Windows hosts file.
   * Requires elevation — runs via `Start-Process -Verb RunAs`.
   * Returns true if the hosts file was updated.
   */
  async updateHostsFile(containerName: string): Promise<boolean> {
    const ip = await this.getContainerIp(containerName);
    if (!ip) {
      vscode.window.showWarningMessage(
        `Could not determine IP for container "${containerName}". Is it running?`,
      );
      return false;
    }
    return this.runElevatedNetworkingScript(
      this.buildHostsScript(containerName, ip),
      `Hosts file updated: ${ip}  ${containerName}`,
      `Could not update hosts file (elevation denied or failed).`,
    );
  }

  /**
   * Download and install the container's self-signed SSL certificate
   * into the Windows Trusted Root store.
   *
   * BC containers serve the cert at http://<name>:8080/certificate.cer.
   * Requires elevation for the import.
   */
  async installContainerCertificate(containerName: string): Promise<boolean> {
    const ip = await this.getContainerIp(containerName);
    if (!ip) {
      vscode.window.showWarningMessage(
        `Could not determine IP for container "${containerName}". Is it running?`,
      );
      return false;
    }
    return this.runElevatedNetworkingScript(
      this.buildCertScript(containerName, ip),
      `SSL certificate for "${containerName}" installed to Trusted Root.`,
      `Could not install certificate (elevation denied or failed).`,
    );
  }

  /**
   * Full container networking setup in a single UAC elevation:
   * 1. Updates the Windows hosts file with the container's IP
   * 2. Downloads and installs the container's self-signed SSL certificate
   *
   * This avoids two separate elevation prompts and ensures the cert
   * download uses the IP directly (no hostname resolution needed).
   */
  async setupContainerNetworking(containerName: string): Promise<boolean> {
    const ip = await this.getContainerIp(containerName);
    if (!ip) {
      vscode.window.showWarningMessage(
        `Could not determine IP for container "${containerName}". Is it running?`,
      );
      return false;
    }

    const combinedScript =
      this.buildHostsScript(containerName, ip) +
      this.buildCertScript(containerName, ip);

    return this.runElevatedNetworkingScript(
      combinedScript,
      `Networking configured for "${containerName}" (hosts + SSL certificate).`,
      `Networking setup failed or was denied.`,
    );
  }

  // ── private networking helpers ───────────────────────────────

  /** Build PowerShell commands to update the hosts file. */
  private buildHostsScript(containerName: string, ip: string): string {
    const hostsPath = String.raw`C:\Windows\System32\drivers\etc\hosts`;
    return (
      `$h = '${hostsPath}'; ` +
      `$lines = (Get-Content $h) | Where-Object { $_ -notmatch '\\s${containerName}$$' }; ` +
      `$lines += '${ip}  ${containerName}'; ` +
      `Set-Content $h ($lines -join [Environment]::NewLine) -Encoding ASCII; `
    );
  }

  /** Build PowerShell commands to download + install the SSL cert using the container IP. */
  private buildCertScript(containerName: string, ip: string): string {
    const certUrl = `http://${ip}:8080/certificate.cer`;
    return (
      `$cert = Join-Path $env:TEMP '${containerName}.cer'; ` +
      `Invoke-WebRequest -Uri '${certUrl}' -OutFile $cert -UseBasicParsing; ` +
      `Import-Certificate -FilePath $cert -CertStoreLocation Cert:\\LocalMachine\\Root; ` +
      `Remove-Item $cert -Force; `
    );
  }

  /**
   * Run a PowerShell script with elevation (single UAC prompt).
   *
   * Writes the script to a temp .ps1 file, then uses
   * `Start-Process -Verb RunAs -File` to elevate it.
   * This avoids all nested-quoting issues that break inline -Command.
   * A marker file is used to detect success / failure.
   */
  private runElevatedNetworkingScript(
    scriptBody: string,
    successMsg: string,
    failMsg: string,
  ): Promise<boolean> {
    const marker = `bcnet_${Date.now()}`;
    const tmpDir = os.tmpdir();
    const markerFile = path.join(tmpDir, `${marker}.ok`);
    const scriptFile = path.join(tmpDir, `${marker}.ps1`);

    // Write a self-contained PS1 that does the work + writes a result marker
    const ps1Content = [
      `$ErrorActionPreference = 'Stop'`,
      `try {`,
      `  ${scriptBody}`,
      `  Set-Content -Path '${markerFile}' -Value 'ok'`,
      `} catch {`,
      `  Set-Content -Path '${markerFile}' -Value $_.Exception.Message`,
      `}`,
    ].join("\r\n");

    fs.writeFileSync(scriptFile, ps1Content, "utf-8");

    // Elevate: Start-Process runs the .ps1 file as admin
    const elevateCmd =
      `Start-Process powershell -Verb RunAs -Wait ` +
      `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptFile}'`;

    return new Promise<boolean>((resolve) => {
      exec(
        `powershell -NoProfile -Command "${elevateCmd}"`,
        { timeout: 120_000 },
        (err) => {
          // Clean up the temp script (best-effort)
          try { fs.unlinkSync(scriptFile); } catch { /* ignore */ }

          if (err) {
            vscode.window.showWarningMessage(failMsg);
            resolve(false);
            return;
          }

          // Read the marker file to check what happened in the elevated session
          try {
            const result = fs.readFileSync(markerFile, "utf-8").trim();
            try { fs.unlinkSync(markerFile); } catch { /* ignore */ }

            if (result === "ok") {
              vscode.window.showInformationMessage(successMsg);
              resolve(true);
            } else {
              vscode.window.showWarningMessage(`Networking setup error: ${result}`);
              resolve(false);
            }
          } catch {
            // Marker file doesn't exist — UAC was denied or script never ran
            vscode.window.showWarningMessage(
              `Networking setup did not complete. Was the UAC prompt accepted?`,
            );
            resolve(false);
          }
        },
      );
    });
  }
}

// ── internal types for docker inspect JSON ────────────────────

interface InspectResult {
  Id: string;
  Config?: {
    Labels?: Record<string, string>;
  };
}
