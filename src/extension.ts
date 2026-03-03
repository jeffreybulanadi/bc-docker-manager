import * as vscode from "vscode";
import { exec } from "child_process";
import { DockerService } from "./docker/dockerService";
import { DockerSetup } from "./docker/dockerSetup";
import { LaunchJsonService } from "./docker/launchJsonService";
import { BcArtifactsService } from "./registry/bcArtifactsService";
import { ContainerProvider } from "./tree/containerProvider";
import { ImageProvider } from "./tree/imageProvider";
import { DockerHealthProvider } from "./tree/dockerHealthProvider";
import { RegistryPanel } from "./webview/registryPanel";
import { ContainerTreeItem, ImageTreeItem } from "./tree/models";

/**
 * Extension entry point.
 *
 * Everything is registered synchronously so that VS Code never
 * reports "command not found". Docker availability is checked
 * separately and only surfaces a non-blocking warning.
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const docker = new DockerService();
  const artifacts = new BcArtifactsService();
  artifacts.setStoragePath(context.globalStorageUri.fsPath);
  const containerProvider = new ContainerProvider(docker);
  const imageProvider = new ImageProvider(docker);
  const healthProvider = new DockerHealthProvider();

  // Preload countries in background so the panel opens instantly.
  // This warms up the TLS connection + populates memory & disk cache.
  artifacts.getCountries("sandbox").catch(() => {});
  artifacts.getCountries("onprem").catch(() => {});

  // ── Tree views (containers + local images + environment health) ─
  context.subscriptions.push(
    vscode.window.createTreeView("bcDockerManager-environment", {
      treeDataProvider: healthProvider,
    }),
    vscode.window.createTreeView("bcDockerManager-containers", {
      treeDataProvider: containerProvider,
    }),
    vscode.window.createTreeView("bcDockerManager-images", {
      treeDataProvider: imageProvider,
    }),
    healthProvider,
  );

  // ── Helper ────────────────────────────────────────────────────
  function refreshAll(): void {
    containerProvider.refresh();
    imageProvider.refresh();
    healthProvider.refresh();
  }

  // ── Commands ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.refresh", refreshAll)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.refreshRegistry", () => {
      // Re-open the explorer (it will reload data)
      RegistryPanel.show(artifacts, docker, context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.openExplorer", () => {
      RegistryPanel.show(artifacts, docker, context.extensionUri);
    })
  );

  // Diagnostic: test CDN connectivity from inside the extension host
  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.testCdn", async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Testing BC Artifacts CDN…" },
        () => artifacts.testConnection(),
      );
      vscode.window.showInformationMessage(`CDN Test: ${result}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.toggleBcFilter", () => {
      containerProvider.toggleBcFilter();
      imageProvider.toggleBcFilter();
    })
  );

  // ── Docker environment fix commands ───────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.setupAll", async () => {
      const checks = healthProvider.checks;
      const failing = checks.filter((c) => c.status !== "ok");
      if (failing.length === 0) {
        vscode.window.showInformationMessage("Environment is ready — you're all set!");
        return;
      }

      const go = await vscode.window.showInformationMessage(
        "Setup will enable Windows features (Hyper-V + Containers) and install Docker Engine.\n\n" +
        "This may require admin elevation and a reboot.",
        { modal: true },
        "Setup Everything",
      );
      if (go !== "Setup Everything") { return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Setting up environment…", cancellable: false },
        async (progress) => {
          const byId = new Map(failing.map((c) => [c.id, c]));

          // Step 1: Enable Windows Features (Hyper-V + Containers)
          if (byId.has("features")) {
            progress.report({ message: "Step 1/2 · Enabling Hyper-V & Containers…" });
            await DockerHealthProvider.enableWindowsFeatures();
          }

          // Step 2: Install Docker Engine (or start if already installed)
          if (byId.has("docker")) {
            const dockerCheck = byId.get("docker")!;
            if (dockerCheck.status === "error") {
              progress.report({ message: "Step 2/2 · Installing Docker Engine…" });
              await DockerSetup.installDockerEngine();
            } else {
              progress.report({ message: "Step 2/2 · Starting Docker Engine…" });
              const ok = await DockerHealthProvider.startDockerEngine();
              if (ok) {
                for (let i = 0; i < 12; i++) {
                  await new Promise((r) => setTimeout(r, 5000));
                  if (await docker.isDockerRunning()) { break; }
                }
              }
            }
          }
        },
      );

      healthProvider.refresh();

      const needsReboot = failing.some((c) => c.id === "features");
      if (needsReboot) {
        const action = await vscode.window.showInformationMessage(
          "Windows features were enabled. A restart is needed for them to take effect.",
          "Restart Now",
          "Later",
        );
        if (action === "Restart Now") {
          exec('shutdown /r /t 30 /c "Restarting for Docker features"');
          vscode.window.showInformationMessage("System will restart in 30 seconds.");
        }
      } else {
        vscode.window.showInformationMessage("Environment setup complete!");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.startDockerEngine", async () => {
      const started = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Starting Docker Engine…" },
        async () => {
          const ok = await DockerHealthProvider.startDockerEngine();
          if (ok) {
            // Wait up to 60s for daemon to become responsive
            for (let i = 0; i < 12; i++) {
              await new Promise((r) => setTimeout(r, 5000));
              if (await docker.isDockerRunning()) { return true; }
            }
          }
          return false;
        },
      );
      if (started) {
        vscode.window.showInformationMessage("Docker Engine is now running!");
        refreshAll();
      } else {
        vscode.window.showWarningMessage(
          "Could not start Docker Engine automatically. Run `net start docker` from an elevated prompt.",
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.enableWindowsFeatures", async () => {
      await DockerHealthProvider.enableWindowsFeatures();
      setTimeout(() => healthProvider.refresh(), 5000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.installDockerEngine", async () => {
      try {
        const installed = await DockerSetup.installDockerEngine();
        if (installed) {
          refreshAll();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Docker Engine installation failed: ${msg}`);
      }
      setTimeout(() => healthProvider.refresh(), 5000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.refreshEnvironment", () => {
      healthProvider.refresh();
    })
  );

  // ── Generate AL launch.json ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.generateLaunchJson",
      async (item?: ContainerTreeItem) => {
        const prefill = item
          ? { containerName: item.container.names, authentication: "UserPassword" }
          : undefined;
        await LaunchJsonService.generate(prefill);
      },
    )
  );

  // ── Copy launch.json to clipboard ────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.copyLaunchJson",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await vscode.window.showInputBox({
          prompt: "Container name",
          placeHolder: "bc25us",
        });
        if (!name) { return; }
        await LaunchJsonService.copyToClipboard({ containerName: name, authentication: "UserPassword" });
      },
    )
  );

  // ── Preview launch.json in new tab ───────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.previewLaunchJson",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await vscode.window.showInputBox({
          prompt: "Container name",
          placeHolder: "bc25us",
        });
        if (!name) { return; }
        await LaunchJsonService.openAsTab({ containerName: name, authentication: "UserPassword" });
      },
    )
  );

  // ── Open Web Client ────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.openWebClient",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }

        // Make sure the container is running and has an IP
        const ip = await docker.getContainerIp(name);
        if (!ip) {
          vscode.window.showErrorMessage(
            `Cannot determine IP for "${name}". Is the container running?`,
          );
          return;
        }

        // Auto-check and fix: hosts file + SSL certificate
        const ready = await docker.ensureNetworking(name);
        if (!ready) {
          vscode.window.showWarningMessage(
            `Networking setup for "${name}" was not completed. ` +
            `Please accept the UAC prompt and try again, or run "Setup Networking" from the context menu.`,
          );
          return;
        }

        // Brief pause after cert install so the Windows cert store
        // propagates and the browser picks up the trusted root.
        // Without this, the first navigation may still show "not secure".
        if (await docker.didNetworkingJustRun()) {
          await new Promise((r) => setTimeout(r, 2000));
        }

        // Everything is configured — open the web client
        vscode.env.openExternal(vscode.Uri.parse(`https://${name}/BC/`));
      },
    )
  );

  // ── Setup Container Networking (hosts + cert, one UAC prompt) ──

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.setupNetworking",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        await docker.setupContainerNetworking(name);
      },
    )
  );

  // ── Update Hosts File ───────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.updateHosts",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        await docker.updateHostsFile(name);
      },
    )
  );

  // ── Install Container SSL Certificate ─────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.installCert",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        await docker.installContainerCertificate(name);
      },
    )
  );

  // ── Open Container Terminal ───────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.openTerminal",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        const terminal = vscode.window.createTerminal({
          name: `BC: ${name}`,
          shellPath: "powershell.exe",
          shellArgs: [
            "-NoProfile",
            "-NoExit",
            "-Command",
            `docker exec -it ${name} powershell`,
          ],
        });
        terminal.show();
      },
    )
  );

  // ── View Container Logs ───────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.viewLogs",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        const terminal = vscode.window.createTerminal({
          name: `Logs: ${name}`,
          shellPath: "powershell.exe",
          shellArgs: [
            "-NoProfile",
            "-NoExit",
            "-Command",
            `docker logs --tail 200 -f ${name}`,
          ],
        });
        terminal.show();
      },
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.startContainer",
      async (item?: ContainerTreeItem) => {
        if (!item) { return; }
        try {
          await withProgress(`Starting "${item.container.names}"...`, () =>
            docker.startContainer(item.container.id)
          );
          vscode.window.showInformationMessage(
            `Container "${item.container.names}" started.`
          );
          refreshAll();
        } catch (err) {
          showError("start", item.container.names, err);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.stopContainer",
      async (item?: ContainerTreeItem) => {
        if (!item) { return; }
        try {
          await withProgress(`Stopping "${item.container.names}"...`, () =>
            docker.stopContainer(item.container.id)
          );
          vscode.window.showInformationMessage(
            `Container "${item.container.names}" stopped.`
          );
          refreshAll();
        } catch (err) {
          showError("stop", item.container.names, err);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.restartContainer",
      async (item?: ContainerTreeItem) => {
        if (!item) { return; }
        try {
          await withProgress(`Restarting "${item.container.names}"...`, () =>
            docker.restartContainer(item.container.id)
          );
          vscode.window.showInformationMessage(
            `Container "${item.container.names}" restarted.`
          );
          refreshAll();
        } catch (err) {
          showError("restart", item.container.names, err);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.removeContainer",
      async (item?: ContainerTreeItem) => {
        if (!item) { return; }
        const answer = await vscode.window.showWarningMessage(
          `Remove container "${item.container.names}"? This cannot be undone.`,
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") { return; }

        try {
          await docker.removeContainer(item.container.id);
          vscode.window.showInformationMessage(
            `Container "${item.container.names}" removed.`
          );
          refreshAll();
        } catch (err) {
          showError("remove", item.container.names, err);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.removeImage",
      async (item?: ImageTreeItem) => {
        if (!item) { return; }
        const label = `${item.image.repository}:${item.image.tag}`;
        const answer = await vscode.window.showWarningMessage(
          `Remove image "${label}"? This cannot be undone.`,
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") { return; }

        try {
          await docker.removeImage(item.image.id);
          vscode.window.showInformationMessage(`Image "${label}" removed.`);
          refreshAll();
        } catch (err) {
          showError("remove image", label, err);
        }
      }
    )
  );

  // Docker health is now handled by the DockerHealthProvider tree view.
  // It auto-polls every 15s and shows live status in the sidebar.
}

export function deactivate(): void {
  // VS Code disposes subscriptions automatically.
}

// ── Helpers ─────────────────────────────────────────────────────

function withProgress(title: string, task: () => Promise<void>): Thenable<void> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task
  );
}

function showError(action: string, name: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`Failed to ${action} "${name}": ${msg}`);
}

/**
 * Show a quick-pick of running containers so commands can be invoked
 * from the Command Palette (not just the tree context menu).
 */
async function pickRunningContainer(docker: DockerService): Promise<string | undefined> {
  const containers = await docker.getContainers();
  const running = containers.filter((c: { state: string }) => c.state.toLowerCase() === "running");
  if (running.length === 0) {
    vscode.window.showWarningMessage("No running containers found.");
    return undefined;
  }
  if (running.length === 1) {
    return running[0].names;
  }
  const pick = await vscode.window.showQuickPick(
    running.map((c: { names: string; image: string }) => ({ label: c.names, description: c.image })),
    { placeHolder: "Select a running container" },
  );
  return pick?.label;
}
