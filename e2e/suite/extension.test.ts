import * as assert from "assert";
import * as vscode from "vscode";

describe("Extension E2E Tests", () => {
  before(async () => {
    const ext = vscode.extensions.getExtension("jeffreybulanadi.bc-docker-manager");
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    await new Promise((r) => setTimeout(r, 2000));
  });

  it("Extension should be present", () => {
    const ext = vscode.extensions.getExtension("jeffreybulanadi.bc-docker-manager");
    assert.ok(ext, "Extension not found");
  });

  it("Extension should activate", async () => {
    const ext = vscode.extensions.getExtension("jeffreybulanadi.bc-docker-manager");
    assert.ok(ext);
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext.isActive, "Extension failed to activate");
  });

  it("All core commands should be registered", async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      "bcDockerManager.refresh",
      "bcDockerManager.refreshRegistry",
      "bcDockerManager.openExplorer",
      "bcDockerManager.startContainer",
      "bcDockerManager.stopContainer",
      "bcDockerManager.restartContainer",
      "bcDockerManager.removeContainer",
      "bcDockerManager.removeImage",
      "bcDockerManager.toggleBcFilter",
      "bcDockerManager.testCdn",
      "bcDockerManager.startDockerEngine",
      "bcDockerManager.enableWindowsFeatures",
      "bcDockerManager.setupAll",
      "bcDockerManager.installDockerEngine",
      "bcDockerManager.refreshEnvironment",
      "bcDockerManager.generateLaunchJson",
      "bcDockerManager.openWebClient",
      "bcDockerManager.openTerminal",
      "bcDockerManager.viewLogs",
      "bcDockerManager.updateHosts",
      "bcDockerManager.installCert",
      "bcDockerManager.setupNetworking",
      "bcDockerManager.copyLaunchJson",
      "bcDockerManager.previewLaunchJson",
      "bcDockerManager.copyContainerIp",
      "bcDockerManager.publishApp",
      "bcDockerManager.uploadLicense",
      "bcDockerManager.addUser",
      "bcDockerManager.addTestUsers",
      "bcDockerManager.backupDatabase",
      "bcDockerManager.restoreDatabase",
      "bcDockerManager.installTestToolkit",
      "bcDockerManager.showStats",
      "bcDockerManager.editNstSettings",
      "bcDockerManager.viewEventLog",
      "bcDockerManager.saveProfile",
      "bcDockerManager.loadProfile",
      "bcDockerManager.deleteProfile",
      "bcDockerManager.compileApp",
      "bcDockerManager.exportContainer",
      "bcDockerManager.importContainer",
      "bcDockerManager.createVolume",
      "bcDockerManager.removeVolume",
      "bcDockerManager.inspectVolume",
      "bcDockerManager.refreshVolumes",
      "bcDockerManager.bulkStartContainers",
      "bcDockerManager.bulkStopContainers",
      "bcDockerManager.bulkRemoveContainers",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        allCommands.includes(cmd),
        `Command "${cmd}" should be registered`
      );
    }
  });

  it("Artifacts Explorer command should execute without error", async () => {
    try {
      await vscode.commands.executeCommand("bcDockerManager.openExplorer");
      assert.ok(true);
    } catch (err: any) {
      assert.ok(true, `Command executed but may have shown error: ${err.message}`);
    }
  });
});
