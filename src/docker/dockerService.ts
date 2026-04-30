import { exec, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { SWRCache } from "../services/swrCache";

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
export class DockerService implements vscode.Disposable {

  /** Fires when background SWR revalidation produces updated data. */
  private readonly _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate: vscode.Event<void> = this._onDidUpdate.event;

  private readonly _containerCache: SWRCache<DockerContainer[]>;
  private readonly _imageCache: SWRCache<DockerImage[]>;

  constructor() {
    const notify = () => this._onDidUpdate.fire();
    this._containerCache = new SWRCache<DockerContainer[]>(10_000, notify);
    this._imageCache = new SWRCache<DockerImage[]>(10_000, notify);
  }

  dispose(): void {
    this._onDidUpdate.dispose();
  }

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

  /** List every container (running + stopped). SWR-cached. */
  async getContainers(): Promise<DockerContainer[]> {
    return this._containerCache.get("all", () => this._fetchContainers());
  }

  private async _fetchContainers(): Promise<DockerContainer[]> {
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
   * Detection strategy - a container is classified as BC if ANY of the
   * following are true (checked in a single pass):
   *  1. Label `nav` is present - set on official BC images by Microsoft.
   *  2. Label `maintainer` equals "Dynamics SMB" - set on official BC images.
   *  3. Image name matches the BC heuristic ("businesscentral" substring or
   *     "bc" as a delimited segment) - catches containers created by this
   *     extension before BC initialisation stamps its own labels.
   *
   * All three checks are applied inclusively so that extension-created
   * containers (which start as the generic base image without labels) are
   * visible in the BC filter from the moment they appear in `docker ps`.
   */
  async getBcContainers(): Promise<DockerContainer[]> {
    return this._containerCache.get("bc", () => this._fetchBcContainers());
  }

  private async _fetchBcContainers(): Promise<DockerContainer[]> {
    // Reuse the already-enriched "all" containers list - no second docker ps or docker inspect.
    const all = await this.getContainers();

    // Inclusive detection: label check OR image-name heuristic in a single O(n) pass.
    // Using an exclusive fallback (only check image name when no labelled containers exist)
    // caused extension-created containers to vanish from the BC view whenever any other
    // labelled BC container was already running.
    return all.filter(
      (c) =>
        "nav" in c.labels ||
        c.labels["maintainer"] === "Dynamics SMB" ||
        this.looksLikeBcImage(c.image),
    );
  }

  async startContainer(id: string): Promise<void> {
    await this.exec(`docker start ${id}`);
    this.invalidateContainers();
  }

  async stopContainer(id: string): Promise<void> {
    await this.exec(`docker stop ${id}`);
    this.invalidateContainers();
  }

  async restartContainer(id: string): Promise<void> {
    await this.exec(`docker restart ${id}`);
    this.invalidateContainers();
  }

  async removeContainer(id: string): Promise<void> {
    await this.exec(`docker rm -f ${id}`);
    this.invalidateContainers();
  }

  // ── images ──────────────────────────────────────────────────

  /** List all locally available Docker images. SWR-cached. */
  async getImages(): Promise<DockerImage[]> {
    return this._imageCache.get("all", () => this._fetchImages());
  }

  private async _fetchImages(): Promise<DockerImage[]> {
    const raw = await this.exec(
      'docker images --no-trunc --format "{{json .}}"'
    );
    return this.parseImageLines(raw);
  }

  /** List only BC-related Docker images. SWR-cached. */
  async getBcImages(): Promise<DockerImage[]> {
    return this._imageCache.get("bc", async () => {
      const all = await this._fetchImages();
      return all.filter((img) => {
        const full = img.repository === "<none>"
          ? ""
          : `${img.repository}:${img.tag}`;
        return this.looksLikeBcImage(full);
      });
    });
  }

  async removeImage(id: string): Promise<void> {
    await this.exec(`docker rmi ${id}`);
    this.invalidateImages();
  }

  /**
   * Pull an image from a registry.
   * @param ref Full image reference, e.g. "mcr.microsoft.com/businesscentral:ltsc2022"
   * @param dockerPath Path to docker executable (default: "docker")
   */
  async pullImage(ref: string, dockerPath = "docker"): Promise<void> {
    await this.exec(`"${dockerPath}" pull ${ref}`, 600_000);
    this.invalidateImages();
  }

  /**
   * Pull a Docker image with real-time layer progress streamed to
   * an OutputChannel and optional VS Code progress notification.
   *
   * Parses `docker pull` output to track per-layer download/extract
   * progress and reports an aggregate percentage.
   */
  async pullImageWithProgress(
    ref: string,
    output: vscode.OutputChannel,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["pull", ref]);
      const layers = new Map<string, { status: string; current: number; total: number }>();
      let lastPct = 0;

      const updateProgress = () => {
        if (!progress) { return; }
        let done = 0;
        let total = 0;
        for (const l of layers.values()) {
          if (l.status === "Already exists" || l.status === "Pull complete") {
            done += l.total || 1;
            total += l.total || 1;
          } else if (l.total > 0) {
            done += l.current;
            total += l.total;
          } else {
            total += 1;
          }
        }
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        if (pct !== lastPct) {
          progress.report({ message: `${pct}% — ${layers.size} layers` });
          lastPct = pct;
        }
      };

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }
          output.appendLine(trimmed);

          // Parse layer progress: "abc123: Downloading  12.5MB/45.2MB"
          const match = trimmed.match(/^([a-f0-9]+):\s+(.+)/i);
          if (match) {
            const [, id, rest] = match;
            const sizeMatch = rest.match(/([\d.]+)\s*[MGK]B\s*\/\s*([\d.]+)\s*[MGK]B/);
            const entry = layers.get(id) || { status: "", current: 0, total: 0 };
            if (sizeMatch) {
              entry.current = parseFloat(sizeMatch[1]);
              entry.total = parseFloat(sizeMatch[2]);
            }
            if (rest.includes("Already exists")) {
              entry.status = "Already exists";
            } else if (rest.includes("Pull complete")) {
              entry.status = "Pull complete";
            } else if (rest.includes("Downloading")) {
              entry.status = "Downloading";
            } else if (rest.includes("Extracting")) {
              entry.status = "Extracting";
            }
            layers.set(id, entry);
            updateProgress();
          }
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        output.append(data.toString());
      });

      child.on("close", (code) => {
        this.invalidateImages();
        if (code === 0) {
          progress?.report({ message: "Pull complete" });
          resolve();
        } else {
          reject(new Error(`docker pull exited with code ${code}`));
        }
      });

      child.on("error", (err) => {
        this.invalidateImages();
        reject(err);
      });
    });
  }

  // ── cache invalidation ─────────────────────────────────────

  /** Invalidate container caches so the next read fetches fresh data. */
  invalidateContainers(): void {
    this._containerCache.invalidateAll();
  }

  /** Invalidate image caches so the next read fetches fresh data. */
  invalidateImages(): void {
    this._imageCache.invalidateAll();
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

  /** Pre-compiled regex for BC image detection. */
  private static readonly BC_IMAGE_REGEX = /(?:^|[\/:\-_])bc(?:[\/:\-_\d]|$)/;

  /** Heuristic: does the image name look BC-related? */
  private looksLikeBcImage(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.includes("businesscentral") || DockerService.BC_IMAGE_REGEX.test(lower);
  }

  /**
   * Maps known BC entrypoint log patterns to concise human-readable phase labels.
   * Ordered from most-specific to least-specific so the first match wins.
   */
  private static readonly _INIT_PHASE_PATTERNS: ReadonlyArray<{ readonly test: RegExp; readonly phase: string }> = [
    { test: /ready for connections|container setup complete/i,            phase: "Ready" },
    { test: /importing license/i,                                         phase: "Importing license" },
    { test: /starting.*nav service|starting.*business central service/i,  phase: "Starting BC service" },
    { test: /install.*business|install.*nav|installing.*bc/i,             phase: "Installing Business Central" },
    { test: /starting sql|sql server.*started|sql server.*running/i,      phase: "Starting SQL Server" },
    { test: /configur.*sql|initializ.*sql|setting up sql/i,               phase: "Configuring SQL Server" },
    { test: /install.*sql|deploying sql/i,                                phase: "Installing SQL Server" },
    { test: /downloading artifact|pulling artifact/i,                     phase: "Downloading artifact" },
    { test: /extracting|unpacking/i,                                      phase: "Extracting artifact" },
    { test: /install.*prereq|copying files/i,                             phase: "Installing prerequisites" },
    { test: /starting container|initializ/i,                              phase: "Initializing" },
  ];

  /**
   * Parse a single BC entrypoint log line into a concise phase label.
   * Returns null if the line does not match any known phase pattern.
   */
  static parseInitPhase(line: string): string | null {
    for (const { test, phase } of DockerService._INIT_PHASE_PATTERNS) {
      if (test.test(line)) { return phase; }
    }
    return null;
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
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<boolean> {
    const log = (msg: string) => output?.appendLine(msg);
    const image = opts.imageName || BC_IMAGE;

    log?.(`Creating container "${opts.containerName}"`);
    log?.(`Image:    ${image}`);
    log?.(`Artifact: ${opts.artifactUrl}`);
    log?.(`Auth:     ${opts.auth || "UserPassword"}`);
    log?.(`Memory:   ${opts.memoryLimit || "8G"}`);
    log?.("");

    // Pre-pull the image with streaming progress so the user sees
    // download % instead of a silent wait.
    log?.(`Pulling image ${image}…`);
    if (output) {
      await this.pullImageWithProgress(image, output, progress);
    } else {
      await this.pullImage(image);
    }
    log?.(`Image ready.\n`);

    // Build the docker run command (no --pull needed, image is fresh)
    const args = this.buildRunArgs(opts, image);

    // Run in a VS Code terminal for full interactive output.
    const quotedArgs = args.map((a) => {
      const escaped = a.replace(/'/g, "''");
      return `'${escaped}'`;
    });
    const cmdLine = `docker ${quotedArgs.join(" ")}`;
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
   *
   * @param onPhase  Called on every poll with the current phase label.
   *                 Use this to drive progress notifications or sidebar updates.
   * @param token    Cancellation token. When cancelled, the loop exits immediately
   *                 and returns false. Caller is responsible for cleanup.
   */
  async waitForContainerReady(
    containerName: string,
    output?: vscode.OutputChannel,
    timeoutMs = 1_800_000,  // 30 minutes max (large artifacts can take 20+ min)
    pollMs = 10_000,        // check every 10s
    onPhase?: (phase: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<boolean> {
    const log = (msg: string) => output?.appendLine(msg);
    const start = Date.now();
    let lastLogLine = "";
    let currentPhase = "Initializing...";

    while (Date.now() - start < timeoutMs) {
      if (token?.isCancellationRequested) { return false; }

      await new Promise((r) => setTimeout(r, pollMs));

      if (token?.isCancellationRequested) { return false; }

      // Check container state + health in one shot
      try {
        const fmt = '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}';
        const raw = await this.exec(
          `docker inspect -f "${fmt}" ${containerName}`,
          10_000,
        );
        const [state, health] = raw.trim().split("|");

        if (health === "healthy") {
          log?.(`\nDone: Container "${containerName}" is ready.`);
          onPhase?.("Ready");
          return true;
        }

        // Container exited before becoming healthy
        if (state === "exited" || state === "dead") {
          log?.(`\nError: Container "${containerName}" ${state} unexpectedly.`);
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
              log?.(`\nDone: Container "${containerName}" is ready. (detected from logs)`);
              onPhase?.("Ready");
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
          const detected = DockerService.parseInitPhase(line);
          if (detected) { currentPhase = detected; }
        }
      } catch { /* container may not exist yet */ }

      onPhase?.(currentPhase);
    }

    log?.(`\nError: Timed out waiting for "${containerName}" to become healthy (${Math.round(timeoutMs / 60_000)} min).`);
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
      "--name", opts.containerName,
      "--hostname", opts.containerName,
      "--memory", opts.memoryLimit || "8G",
      "--isolation", opts.isolation || "hyperv",
      // Explicit DNS: Hyper-V containers often fail to resolve Azure
      // Front Door CDN hostnames with the inherited host DNS, which
      // causes artifact downloads to return error pages instead of ZIPs.
      "--dns", "8.8.8.8",
      "--dns", "8.8.4.4",
      // No -p port mappings: Hyper-V containers get their own NAT IP,
      // so we access them via hostname/IP directly. Publishing ports
      // would conflict when running multiple containers.
      // Environment variables recognised by the MCR BC entrypoint
      "-e", `accept_eula=${opts.accept_eula === false ? "N" : "Y"}`,
      "-e", `artifactUrl=${opts.artifactUrl}`,
      "-e", `username=${opts.username}`,
      "-e", `password=${opts.password}`,
      "-e", `auth=${opts.auth || "UserPassword"}`,
      // Stamp a "nav" label so this container is immediately recognised by
      // the BC filter without waiting for BC initialisation to set its own labels.
      "--label", "nav=extension-created",
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
      const escaped = containerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match: <whitespace><containerName><word-boundary><optional-whitespace><end-of-line>
      // Skip comment lines (lines where the first non-whitespace char is '#')
      // to avoid false-positives like: "# 1.2.3.4  containerName"
      const linePattern = new RegExp(`\\s${escaped}\\b\\s*$`);
      for (const line of hosts.split("\n")) {
        if (line.trimStart().startsWith("#")) { continue; }
        if (linePattern.test(line)) { return true; }
      }
      return false;
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
