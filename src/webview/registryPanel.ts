import * as vscode from "vscode";
import {
  BcArtifactsService,
  BcArtifactType,
  BcArtifactVersion,
} from "../registry/bcArtifactsService";
import { DockerService } from "../docker/dockerService";
import { DockerSetup } from "../docker/dockerSetup";
import { LaunchJsonService } from "../docker/launchJsonService";


/**
 * WebviewPanel that shows BC Artifacts in a grid.
 *
 * Architecture: all CSS and JS live in external files under media/.
 * The HTML returned by _getHtml() is a thin skeleton that references
 * those files via vscode-resource URIs.  This means:
 *  - No inline <script> or <style> blocks
 *  - CSP uses webview.cspSource (no nonce juggling)
 *  - Zero rendering-block issues
 */
export class RegistryPanel {
  public static readonly viewType = "bcDockerManager.artifactsExplorer";
  private static _instance: RegistryPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _artifacts: BcArtifactsService;
  private readonly _docker: DockerService;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private _cache = new Map<string, BcArtifactVersion[]>();
  private _fullyCached = new Set<string>();
  private static readonly PAGE_SIZE = 50;
  private _initialized = false;

  // ─── Construction ────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    artifacts: BcArtifactsService,
    docker: DockerService,
    extensionUri: vscode.Uri,
  ) {
    this._panel = panel;
    this._artifacts = artifacts;
    this._docker = docker;
    this._extensionUri = extensionUri;

    this._panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Set HTML — external JS sends "ready" once loaded
    this._panel.webview.html = this._getHtml();

    // Failsafe: if "ready" never arrives, init after 2 s
    setTimeout(() => {
      if (!this._initialized) {
        this._doInit();
      }
    }, 2000);
  }

  public static show(
    artifacts: BcArtifactsService,
    docker: DockerService,
    extensionUri: vscode.Uri,
  ): void {
    if (RegistryPanel._instance) {
      RegistryPanel._instance._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      RegistryPanel.viewType,
      "BC Artifacts Explorer",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    RegistryPanel._instance = new RegistryPanel(panel, artifacts, docker, extensionUri);
  }

  public dispose(): void {
    RegistryPanel._instance = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }

  // ─── Messages from webview ───────────────────────────────────

  private async _onMessage(msg: { command: string; [k: string]: unknown }): Promise<void> {
    switch (msg.command) {
      case "ready":
        this._doInit();
        break;

      case "loadCountry":
        await this._handleLoadCountry(
          msg.type as BcArtifactType,
          msg.country as string | undefined,
        );
        break;

      case "loadMore":
        this._sendChunk(
          msg.type as string,
          msg.country as string,
          msg.offset as number,
        );
        break;

      case "loadMajor":
        await this._handleLoadMajor(
          msg.type as BcArtifactType,
          msg.country as string,
          msg.major as number,
        );
        break;

      case "copyUrl":
        await vscode.env.clipboard.writeText(msg.url as string);
        vscode.window.showInformationMessage(`Copied: ${msg.url}`);
        break;

      case "copyVersion":
        await vscode.env.clipboard.writeText(msg.version as string);
        vscode.window.showInformationMessage(`Copied: ${msg.version}`);
        break;

      case "createContainer":
        await this._handleCreateContainer(msg);
        break;
    }
  }

  // ─── Container creation (native docker run) ──────────────────

  private async _handleCreateContainer(msg: Record<string, unknown>): Promise<void> {
    const artifactType = msg.type as string;
    const version = msg.version as string;
    const country = msg.country as string;
    const artifactUrl = msg.artifactUrl as string;

    // 1. Ensure Docker Engine is ready
    const ready = await DockerSetup.ensureDocker();
    if (!ready) { return; }

    // 2. Container name
    const defaultName = `bc${version.split(".")[0]}${country}`;
    const name = await vscode.window.showInputBox({
      title: "Create BC Container (1/3): Name",
      prompt: "Container name (lowercase, no spaces)",
      value: defaultName,
      validateInput: (v) => {
        if (!v) { return "Name is required"; }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v)) {
          return "Invalid container name. Use letters, numbers, dash, dot, or underscore";
        }
        return undefined;
      },
    });
    if (!name) { return; } // cancelled

    // 3. Credentials
    const username = await vscode.window.showInputBox({
      title: "Create BC Container (2/3): Username",
      prompt: "Admin username for the BC instance",
      value: "admin",
    });
    if (!username) { return; }

    const password = await vscode.window.showInputBox({
      title: "Create BC Container (3/3): Password",
      prompt: "Admin password",
      password: true,
      validateInput: (v) => {
        if (!v || v.length < 1) { return "Password is required"; }
        return undefined;
      },
    });
    if (!password) { return; }

    // 4. Accept EULA
    const eula = await vscode.window.showWarningMessage(
      "Do you accept the Microsoft Software License Terms for Business Central?\n" +
      "https://go.microsoft.com/fwlink/?linkid=2009120",
      { modal: true },
      "Accept",
    );
    if (eula !== "Accept") { return; }

    // 5. Create container using native docker run
    const config = vscode.workspace.getConfiguration("bcDockerManager");
    const memoryLimit = config.get<string>("defaultMemory", "8G");
    const isolation = config.get<"hyperv" | "process">("defaultIsolation", "hyperv");
    const auth = config.get<string>("defaultAuth", "UserPassword");

    const output = vscode.window.createOutputChannel("BC Container Creation");
    output.show(true);

    try {
      // Phase 1: Pull image with real-time progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pulling BC image`,
          cancellable: false,
        },
        (progress) => this._docker.createBcContainer(
          {
            containerName: name,
            artifactUrl,
            username,
            password,
            memoryLimit,
            isolation,
            auth,
            updateHosts: true,
          },
          output,
          progress,
        ),
      );

      // Phase 2: Wait for the container to fully initialize
      const containerReady = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Initializing container "${name}"`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Downloading artifacts and installing BC (5-15 min)..." });
          return this._docker.waitForContainerReady(name, output);
        },
      );

      vscode.commands.executeCommand("bcDockerManager.refresh");

      if (!containerReady) {
        output.appendLine(`\nWARNING: Health check timed out, but the container may still be initializing.`);
        output.appendLine(`Proceeding with networking setup anyway...`);
      }

      // Always setup networking (hosts + SSL cert) regardless of health check result.
      // The container's web server may still be starting, but the cert endpoint
      // (port 8080) and the NAT IP are available as soon as the container is running.
      output.appendLine(`\nSetting up networking (hosts file + SSL certificate)...`);
      const netOk = await this._docker.setupContainerNetworking(name);
      if (!netOk) {
        output.appendLine(`WARNING: Networking setup was skipped or failed. ` +
          `You can run it later via the container context menu or by clicking Open Web Client.`);
      } else {
        output.appendLine(`Networking configured successfully.`);
      }

      // Offer to generate AL launch.json
      const genLaunch = await vscode.window.showInformationMessage(
        `Generate an AL launch.json to connect to "${name}"?`,
        "Generate launch.json",
        "Skip",
      );
      if (genLaunch === "Generate launch.json") {
        await LaunchJsonService.generate({
          containerName: name,
          authentication: "UserPassword",
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      output.appendLine(`\nERROR: ${errMsg}`);
      vscode.window.showErrorMessage(`Failed to create container: ${errMsg}`);
    }
  }

  // ─── Data loading ────────────────────────────────────────────

  private _doInit(): void {
    if (this._initialized) { return; }
    this._initialized = true;
    this._initPanel();
  }

  private async _initPanel(): Promise<void> {
    const config = vscode.workspace.getConfiguration("bcDockerManager");
    const defaultCountry = config.get<string>("defaultCountry", "us");
    await this._handleLoadCountry("sandbox", defaultCountry);
  }

  private async _handleLoadCountry(
    type: BcArtifactType,
    country?: string,
  ): Promise<void> {
    try {
      const countries = await this._artifacts.getCountries(type);
      this._post({ command: "countries", type, countries });

      const target = country || (countries.includes("us") ? "us" : countries[0] || "w1");
      await this._loadVersions(type, target);
    } catch (err) {
      this._post({
        command: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _loadVersions(type: BcArtifactType, country: string): Promise<void> {
    const key = `${type}/${country}`;

    try {
      if (this._fullyCached.has(key)) {
        const all = this._cache.get(key)!;
        const initial = all.slice(0, RegistryPanel.PAGE_SIZE);
        // Majors can be derived client-side from full cache
        const majorSet = new Set(all.map((v) => v.major));
        const majors = Array.from(majorSet).sort((a, b) => b - a);
        this._post({ command: "majorVersions", majors });
        this._post({
          command: "versions",
          type, country,
          versions: initial.map(serializeVersion),
          totalCount: all.length,
          offset: initial.length,
          hasMore: initial.length < all.length,
        });
        return;
      }

      // Fetch majors and latest page in parallel
      const [majors, { versions: latest, totalCount }] = await Promise.all([
        this._artifacts.getMajorVersions(type, country),
        this._artifacts.getLatestVersions(type, country, RegistryPanel.PAGE_SIZE),
      ]);

      this._post({ command: "majorVersions", majors });

      this._cache.set(key, latest);

      this._post({
        command: "versions",
        type, country,
        versions: latest.map(serializeVersion),
        totalCount,
        offset: latest.length,
        hasMore: latest.length < totalCount,
      });

      // Background: fetch full list for infinite scroll
      if (!this._fullyCached.has(key)) {
        this._artifacts.getVersions(type, country).then((all) => {
          this._cache.set(key, all);
          this._fullyCached.add(key);
          this._post({ command: "fullDataReady", type, country, totalCount: all.length });
        }).catch(() => { /* best effort */ });
      }
    } catch (err) {
      this._post({
        command: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load all versions for a specific major version.
   * Called when the user selects a major from the dropdown.
   */
  private async _handleLoadMajor(
    type: BcArtifactType,
    country: string,
    major: number,
  ): Promise<void> {
    try {
      const versions = await this._artifacts.getVersionsByMajor(type, country, major);
      this._post({
        command: "majorVersions_data",
        type, country, major,
        versions: versions.map(serializeVersion),
        totalCount: versions.length,
      });
    } catch (err) {
      this._post({
        command: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _sendChunk(type: string, country: string, offset: number): void {
    const key = `${type}/${country}`;
    const all = this._cache.get(key);
    if (!all) { return; }

    const chunk = all.slice(offset, offset + RegistryPanel.PAGE_SIZE);
    const newOffset = offset + chunk.length;

    this._post({
      command: "moreVersions",
      versions: chunk.map(serializeVersion),
      totalCount: all.length,
      offset: newOffset,
      hasMore: newOffset < all.length,
    });
  }

  private _post(msg: Record<string, unknown>): void {
    this._panel.webview.postMessage(msg);
  }

  // ─── HTML (skeleton only — logic is in media/) ───────────────

  private _getHtml(): string {
    const webview = this._panel.webview;

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "registry.css"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "registry.js"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>

  <!-- Header -->
  <div class="header">
    <div class="logo"><div class="icon">BC</div> BC Artifacts Explorer</div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" data-type="sandbox">SANDBOX</div>
    <div class="tab" data-type="onprem">ONPREM</div>
  </div>

  <!-- Toolbar -->
  <div class="toolbar">
    <div class="search-box">
      <label style="margin-right:6px;">Search:</label>
      <input type="text" id="searchInput" placeholder="Type to filter" />
    </div>
    <div class="filter-group">
      <label>Country:</label>
      <select id="countrySelect"><option value="">Loading\u2026</option></select>
    </div>
    <div class="filter-group">
      <label>Major:</label>
      <select id="majorSelect"><option value="all">All</option></select>
    </div>
    <span class="status-text" id="statusText"></span>
  </div>

  <!-- Table area -->
  <div class="table-wrapper" id="tableWrapper">
    <div class="state-box" id="promptState">
      <span>Select a country to view available artifacts.</span>
    </div>
    <div class="state-box" id="loadingState" style="display:none">
      <div class="spinner"></div>
      <span>Loading artifacts\u2026</span>
    </div>
    <div class="state-box" id="errorState" style="display:none">
      <span class="error-text" id="errorText"></span>
    </div>
    <table id="dataTable" style="display:none">
      <thead>
        <tr>
          <th class="col-type"    data-sort="type">Type    <span class="sort-icon"></span></th>
          <th class="col-major"   data-sort="major">Major  <span class="sort-icon">\u2193</span></th>
          <th class="col-version" data-sort="version">Version <span class="sort-icon"></span></th>
          <th class="col-country" data-sort="country">Country <span class="sort-icon"></span></th>
          <th class="col-date"    data-sort="date">Published <span class="sort-icon"></span></th>
          <th class="col-actions">Actions</th>
        </tr>
      </thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>

  <script src="${jsUri}"></script>
</body>
</html>`;
  }
}

// ─── Utility ────────────────────────────────────────────────────

function serializeVersion(v: BcArtifactVersion) {
  return {
    version: v.version,
    major: v.major,
    minor: v.minor,
    country: v.country,
    type: v.type,
    creationTime: v.creationTime,
    artifactUrl: v.artifactUrl,
  };
}
