import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ────────────────────────── Interfaces ──────────────────────────

/** A single AL launch.json configuration. */
export interface AlLaunchConfig {
  name: string;
  type: "al";
  request: "launch";
  environmentType: "OnPrem";
  server: string;
  serverInstance: string;
  authentication: string;
  port: number;
  startupObjectId: number;
  startupObjectType: string;
  breakOnError: string;
  launchBrowser: boolean;
  enableLongRunningSqlStatements: boolean;
  enableSqlInformationDebugger: boolean;
  tenant?: string;
}

/** Minimal info needed to generate a launch config for a container. */
export interface ContainerLaunchInfo {
  containerName: string;
  authentication?: string;  // "UserPassword" (default) | "NavUserPassword" | "Windows"
  port?: number;             // dev services port (default 7049)
  serverInstance?: string;   // usually "BC"
}

// ────────────────────────── Service ─────────────────────────────

/**
 * Generates and manages AL launch.json configurations for BC containers.
 *
 * The AL Language extension uses `.vscode/launch.json` to know where
 * the BC server lives, what authentication to use, and which port
 * to publish extensions to.
 */
export class LaunchJsonService {

  /**
   * Build an AL launch configuration object for a BC container.
   */
  static buildConfig(info: ContainerLaunchInfo): AlLaunchConfig {
    return {
      name: info.containerName,
      type: "al",
      request: "launch",
      environmentType: "OnPrem",
      server: `https://${info.containerName}`,
      serverInstance: info.serverInstance || "BC",
      authentication: info.authentication || "UserPassword",
      port: info.port || 7049,
      startupObjectId: 22,
      startupObjectType: "Page",
      breakOnError: "All",
      launchBrowser: true,
      enableLongRunningSqlStatements: true,
      enableSqlInformationDebugger: true,
    };
  }

  /**
   * Copy a full launch.json snippet to the clipboard.
   */
  static async copyToClipboard(info: ContainerLaunchInfo): Promise<void> {
    const config = LaunchJsonService.buildConfig(info);
    const launch = { version: "0.2.0", configurations: [config] };
    const text = JSON.stringify(launch, null, 4);

    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(
      `launch.json for "${info.containerName}" copied to clipboard.`,
    );
  }

  /**
   * Open a new untitled editor tab with the launch.json content
   * so the user can review / edit before saving.
   */
  static async openAsTab(info: ContainerLaunchInfo): Promise<void> {
    const config = LaunchJsonService.buildConfig(info);
    const launch = { version: "0.2.0", configurations: [config] };
    const text = JSON.stringify(launch, null, 4);

    const doc = await vscode.workspace.openTextDocument({
      content: text,
      language: "jsonc",
    });
    await vscode.window.showTextDocument(doc);
  }

  /**
   * Interactive command: ask the user for container details, pick a
   * target workspace folder, then write / merge the launch.json.
   *
   * If `prefill` is given the prompts are pre-populated (used right
   * after container creation).
   */
  static async generate(prefill?: ContainerLaunchInfo): Promise<void> {
    // 1. Container name
    const containerName = prefill?.containerName ?? await vscode.window.showInputBox({
      title: "Generate AL launch.json — Container Name",
      prompt: "Name of the BC container to connect to",
      placeHolder: "bc25us",
      validateInput: (v) => v?.trim() ? undefined : "Container name is required",
    });
    if (!containerName) { return; }

    // 2. Authentication
    const auth = prefill?.authentication ?? await vscode.window.showQuickPick(
      ["UserPassword", "NavUserPassword", "Windows"],
      { title: "Authentication Type", placeHolder: "Select authentication method" },
    );
    if (!auth) { return; }

    // 3. Pick target folder (if multi-root workspace)
    const folders = vscode.workspace.workspaceFolders;
    let targetFolder: vscode.Uri | undefined;

    if (!folders || folders.length === 0) {
      // No workspace open — offer to pick a folder
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select AL project folder",
        title: "Where should the launch.json be created?",
      });
      if (!picked || picked.length === 0) { return; }
      targetFolder = picked[0];
    } else if (folders.length === 1) {
      // Check if this looks like an AL project (has app.json)
      const appJson = path.join(folders[0].uri.fsPath, "app.json");
      if (fs.existsSync(appJson)) {
        targetFolder = folders[0].uri;
      } else {
        // Not an AL project — ask user to pick the right folder
        const choice = await vscode.window.showWarningMessage(
          "The current workspace doesn't appear to be an AL project (no app.json found).",
          "Select AL Project Folder",
          "Use Current Folder Anyway",
        );
        if (choice === "Select AL Project Folder") {
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: "Select AL project folder",
            title: "Where should the launch.json be created?",
          });
          if (!picked || picked.length === 0) { return; }
          targetFolder = picked[0];
        } else if (choice === "Use Current Folder Anyway") {
          targetFolder = folders[0].uri;
        } else {
          return; // cancelled
        }
      }
    } else {
      const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: "Which workspace folder should get the launch.json?",
      });
      if (!picked) { return; }
      targetFolder = picked.uri;
    }

    // 4. Build config
    const config = LaunchJsonService.buildConfig({
      containerName: containerName.trim(),
      authentication: auth,
      port: prefill?.port,
      serverInstance: prefill?.serverInstance,
    });

    // 5. Write / merge
    const vscodeDir = path.join(targetFolder.fsPath, ".vscode");
    const launchPath = path.join(vscodeDir, "launch.json");

    await LaunchJsonService.mergeConfig(launchPath, config);

    // 6. Open the file
    const doc = await vscode.workspace.openTextDocument(launchPath);
    await vscode.window.showTextDocument(doc);

    vscode.window.showInformationMessage(
      `AL launch configuration "${containerName}" added to launch.json. ` +
      `Use the AL Language extension to publish & debug.`,
    );
  }

  /**
   * Merge a new configuration into an existing launch.json, or
   * create the file from scratch if it doesn't exist.
   *
   * If a configuration with the same `name` already exists it is
   * replaced (updated). Otherwise it's appended.
   */
  static async mergeConfig(launchPath: string, config: AlLaunchConfig): Promise<void> {
    const dir = path.dirname(launchPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let launch: { version: string; configurations: AlLaunchConfig[] };

    if (fs.existsSync(launchPath)) {
      try {
        // Parse existing file (strip BOM + comments for JSONC)
        const raw = fs.readFileSync(launchPath, "utf-8");
        const stripped = LaunchJsonService.stripJsonComments(raw);
        launch = JSON.parse(stripped);

        if (!Array.isArray(launch.configurations)) {
          launch.configurations = [];
        }
      } catch {
        // Corrupt file — back it up and start fresh
        const backup = launchPath + `.backup-${Date.now()}`;
        fs.copyFileSync(launchPath, backup);
        vscode.window.showWarningMessage(
          `Existing launch.json could not be parsed — backed up to ${path.basename(backup)}.`,
        );
        launch = { version: "0.2.0", configurations: [] };
      }
    } else {
      launch = { version: "0.2.0", configurations: [] };
    }

    // Replace existing config with same name, or append
    const idx = launch.configurations.findIndex(
      (c) => c.name === config.name,
    );
    if (idx >= 0) {
      launch.configurations[idx] = config;
    } else {
      launch.configurations.push(config);
    }

    fs.writeFileSync(launchPath, JSON.stringify(launch, null, 4), "utf-8");
  }

  /**
   * Minimal JSONC comment stripper — handles // and /* ... *\/ style
   * comments outside of strings.
   * Also strips a leading UTF-8 BOM (\uFEFF) if present.
   */
  static stripJsonComments(text: string): string {
    // Remove BOM that Windows tools may prepend to UTF-8 files
    text = text.replace(/^\uFEFF/, "");
    let result = "";
    let i = 0;
    let inString = false;
    let escape = false;

    while (i < text.length) {
      const ch = text[i];

      if (inString) {
        result += ch;
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        i++;
        continue;
      }

      // Not in a string
      if (ch === '"') {
        inString = true;
        result += ch;
        i++;
      } else if (ch === "/" && text[i + 1] === "/") {
        // Line comment — skip until newline
        while (i < text.length && text[i] !== "\n") { i++; }
      } else if (ch === "/" && text[i + 1] === "*") {
        // Block comment — skip until */
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { i++; }
        i += 2; // skip closing */
      } else {
        result += ch;
        i++;
      }
    }
    return result;
  }
}
