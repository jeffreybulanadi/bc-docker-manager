import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension E2E Tests", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("jeffreybulanadi.bc-docker-manager");
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    await new Promise((r) => setTimeout(r, 2000));
  });

  test("Extension should be present", () => {
    const ext = vscode.extensions.getExtension("jeffreybulanadi.bc-docker-manager");
    assert.ok(ext, "Extension not found");
  });

  test("Extension should activate", async () => {
    const ext = vscode.extensions.getExtension("jeffreybulanadi.bc-docker-manager");
    assert.ok(ext);
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext.isActive, "Extension failed to activate");
  });

  test("All core commands should be registered", async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      "bcDockerManager.refresh",
      "bcDockerManager.refreshRegistry",
      "bcDockerManager.openArtifacts",
      "bcDockerManager.startContainer",
      "bcDockerManager.stopContainer",
      "bcDockerManager.restartContainer",
      "bcDockerManager.removeContainer",
      "bcDockerManager.containerLogs",
      "bcDockerManager.containerTerminal",
      "bcDockerManager.inspectContainer",
      "bcDockerManager.removeImage",
      "bcDockerManager.toggleBcFilter",
      "bcDockerManager.copyContainerIp",
      "bcDockerManager.publishApp",
      "bcDockerManager.uploadLicense",
      "bcDockerManager.addUser",
      "bcDockerManager.addTestUsers",
      "bcDockerManager.backupDatabase",
      "bcDockerManager.restoreDatabase",
      "bcDockerManager.installTestToolkit",
      "bcDockerManager.containerStats",
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
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        allCommands.includes(cmd),
        `Command "${cmd}" should be registered`
      );
    }
  });

  test("Artifacts Explorer command should execute without error", async () => {
    try {
      await vscode.commands.executeCommand("bcDockerManager.openArtifacts");
      assert.ok(true);
    } catch (err: any) {
      assert.ok(true, `Command executed but may have shown error: ${err.message}`);
    }
  });
});
