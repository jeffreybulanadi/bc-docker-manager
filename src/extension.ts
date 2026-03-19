import * as vscode from "vscode";
import { exec } from "child_process";
import { DockerService } from "./docker/dockerService";
import { DockerSetup } from "./docker/dockerSetup";
import { LaunchJsonService } from "./docker/launchJsonService";
import { BcContainerService } from "./docker/bcContainerService";
import { BcArtifactsService } from "./registry/bcArtifactsService";
import { ContainerProvider } from "./tree/containerProvider";
import { ImageProvider } from "./tree/imageProvider";
import { DockerHealthProvider } from "./tree/dockerHealthProvider";
import { VolumeProvider } from "./tree/volumeProvider";
import { ArtifactsProvider } from "./tree/artifactsProvider";
import { RegistryPanel } from "./webview/registryPanel";
import { ContainerTreeItem, ImageTreeItem } from "./tree/models";
import { VolumeTreeItem } from "./tree/volumeProvider";

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
  const bcService = new BcContainerService(docker);
  const artifacts = new BcArtifactsService();
  artifacts.setStoragePath(context.globalStorageUri.fsPath);
  bcService.setProfileStoragePath(context.globalStorageUri.fsPath);
  const containerProvider = new ContainerProvider(docker);
  const imageProvider = new ImageProvider(docker);
  const healthProvider = new DockerHealthProvider();
  const volumeProvider = new VolumeProvider(bcService);
  const artifactsProvider = new ArtifactsProvider(artifacts);

  // Preload countries in background so the panel opens instantly.
  // This warms up the TLS connection + populates memory & disk cache.
  artifacts.getCountries("sandbox").catch(() => {});
  artifacts.getCountries("onprem").catch(() => {});

  // ── Tree views ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.createTreeView("bcDockerManager-environment", {
      treeDataProvider: healthProvider,
    }),
    vscode.window.createTreeView("bcDockerManager-artifacts", {
      treeDataProvider: artifactsProvider,
    }),
    vscode.window.createTreeView("bcDockerManager-containers", {
      treeDataProvider: containerProvider,
    }),
    vscode.window.createTreeView("bcDockerManager-images", {
      treeDataProvider: imageProvider,
    }),
    vscode.window.createTreeView("bcDockerManager-volumes", {
      treeDataProvider: volumeProvider,
    }),
    healthProvider,
  );

  // ── SWR: refresh tree views when background revalidation finds new data ─
  context.subscriptions.push(
    docker.onDidUpdate(() => refreshAll()),
  );

  // ── Helper ────────────────────────────────────────────────────
  let _refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function refreshAll(): void {
    // Debounce rapid calls (e.g. bulk operations triggering multiple refreshes)
    if (_refreshTimer) { clearTimeout(_refreshTimer); }
    _refreshTimer = setTimeout(() => {
      _refreshTimer = undefined;
      containerProvider.refresh();
      imageProvider.refresh();
      healthProvider.refresh();
      volumeProvider.refresh();
    }, 300);
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

  // ── v1.1: Copy Container IP ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.copyContainerIp",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.copyContainerIp(name);
        } catch (err) {
          showError("copy IP for", name, err);
        }
      },
    )
  );

  // ── v1.1: Publish AL App ─────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.publishApp",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.publishApp(name);
        } catch (err) {
          showError("publish app to", name, err);
        }
      },
    )
  );

  // ── v1.1: Upload License ─────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.uploadLicense",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.uploadLicense(name);
        } catch (err) {
          showError("upload license to", name, err);
        }
      },
    )
  );

  // ── v1.2: User Management ────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.addUser",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.addUser(name);
        } catch (err) {
          showError("add user to", name, err);
        }
      },
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.addTestUsers",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.addTestUsers(name);
        } catch (err) {
          showError("add test users to", name, err);
        }
      },
    )
  );

  // ── v1.2: Database Backup & Restore ──────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.backupDatabase",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.backupDatabase(name);
        } catch (err) {
          showError("backup database for", name, err);
        }
      },
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.restoreDatabase",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.restoreDatabase(name);
        } catch (err) {
          showError("restore database for", name, err);
        }
      },
    )
  );

  // ── v1.2: Install Test Toolkit ───────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.installTestToolkit",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.installTestToolkit(name);
        } catch (err) {
          showError("install test toolkit on", name, err);
        }
      },
    )
  );

  // ── v1.3: Container Resource Monitor ─────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.showStats",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.showContainerStats(name);
        } catch (err) {
          showError("show stats for", name, err);
        }
      },
    )
  );

  // ── v1.3: Edit NST Settings ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.editNstSettings",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.editNstSettings(name);
        } catch (err) {
          showError("edit NST settings for", name, err);
        }
      },
    )
  );

  // ── v1.3: Container Event Log ────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.viewEventLog",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.viewEventLog(name);
        } catch (err) {
          showError("view event log for", name, err);
        }
      },
    )
  );

  // ── v1.3: Container Profiles ─────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.saveProfile", async () => {
      try {
        await bcService.saveProfile();
      } catch (err) {
        showError("save", "profile", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.loadProfile", async () => {
      try {
        await bcService.loadProfile();
      } catch (err) {
        showError("load", "profile", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.deleteProfile", async () => {
      try {
        await bcService.deleteProfile();
      } catch (err) {
        showError("delete", "profile", err);
      }
    })
  );

  // ── v1.4: Compile AL App ─────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.compileApp",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names ?? await pickRunningContainer(docker);
        if (!name) { return; }
        try {
          await bcService.compileApp(name);
        } catch (err) {
          showError("compile app in", name, err);
        }
      },
    )
  );

  // ── v1.4: Container Export/Import ────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.exportContainer",
      async (item?: ContainerTreeItem) => {
        const name = item?.container.names;
        if (!name) { return; }
        try {
          await bcService.exportContainer(name);
          refreshAll();
        } catch (err) {
          showError("export", name, err);
        }
      },
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.importContainer", async () => {
      try {
        await bcService.importContainer();
        refreshAll();
      } catch (err) {
        showError("import", "container", err);
      }
    })
  );

  // ── v1.4: Volume Management ──────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.refreshVolumes", () => {
      volumeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.createVolume", async () => {
      try {
        await bcService.createVolume();
        volumeProvider.refresh();
      } catch (err) {
        showError("create", "volume", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.removeVolume",
      async (item?: VolumeTreeItem) => {
        if (!item) { return; }
        const answer = await vscode.window.showWarningMessage(
          `Remove volume "${item.volume.name}"? This cannot be undone.`,
          { modal: true },
          "Remove",
        );
        if (answer !== "Remove") { return; }
        try {
          await bcService.removeVolume(item.volume.name);
          vscode.window.showInformationMessage(`Volume "${item.volume.name}" removed.`);
          volumeProvider.refresh();
        } catch (err) {
          showError("remove volume", item.volume.name, err);
        }
      },
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bcDockerManager.inspectVolume",
      async (item?: VolumeTreeItem) => {
        if (!item) { return; }
        try {
          await bcService.inspectVolume(item.volume.name);
        } catch (err) {
          showError("inspect volume", item.volume.name, err);
        }
      },
    )
  );

  // ── v1.4: Bulk Container Operations ──────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.bulkStartContainers", async () => {
      const containers = await docker.getContainers();
      const stopped = containers.filter((c) => c.state.toLowerCase() !== "running");
      if (stopped.length === 0) {
        vscode.window.showInformationMessage("No stopped containers to start.");
        return;
      }
      const confirm = await vscode.window.showInformationMessage(
        `Start ${stopped.length} stopped container(s)?`,
        { modal: true },
        "Start All",
      );
      if (confirm !== "Start All") { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Starting containers…" },
        async (progress) => {
          for (const c of stopped) {
            progress.report({ message: c.names });
            try { await docker.startContainer(c.id); } catch { /* continue */ }
          }
        },
      );
      refreshAll();
      vscode.window.showInformationMessage(`${stopped.length} container(s) started.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.bulkStopContainers", async () => {
      const containers = await docker.getContainers();
      const running = containers.filter((c) => c.state.toLowerCase() === "running");
      if (running.length === 0) {
        vscode.window.showInformationMessage("No running containers to stop.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Stop ${running.length} running container(s)?`,
        { modal: true },
        "Stop All",
      );
      if (confirm !== "Stop All") { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Stopping containers…" },
        async (progress) => {
          for (const c of running) {
            progress.report({ message: c.names });
            try { await docker.stopContainer(c.id); } catch { /* continue */ }
          }
        },
      );
      refreshAll();
      vscode.window.showInformationMessage(`${running.length} container(s) stopped.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bcDockerManager.bulkRemoveContainers", async () => {
      const containers = await docker.getContainers();
      const stopped = containers.filter((c) => c.state.toLowerCase() !== "running");
      if (stopped.length === 0) {
        vscode.window.showInformationMessage("No stopped containers to remove.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${stopped.length} stopped container(s)? This cannot be undone.`,
        { modal: true },
        "Remove All",
      );
      if (confirm !== "Remove All") { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Removing containers…" },
        async (progress) => {
          for (const c of stopped) {
            progress.report({ message: c.names });
            try { await docker.removeContainer(c.id); } catch { /* continue */ }
          }
        },
      );
      refreshAll();
      vscode.window.showInformationMessage(`${stopped.length} container(s) removed.`);
    })
  );
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
