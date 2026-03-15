import * as vscode from "vscode";
import { BcContainerService, DockerVolume } from "../docker/bcContainerService";

// ──────────────────────── Volume Tree Item ─────────────────────

export class VolumeTreeItem extends vscode.TreeItem {
  constructor(public readonly volume: DockerVolume) {
    super(volume.name, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "volume";
    this.iconPath = new vscode.ThemeIcon("database");
    this.description = volume.driver;

    this.tooltip = new vscode.MarkdownString(
      [
        `**${volume.name}**`,
        "",
        `| Field | Value |`,
        `|-------|-------|`,
        `| Driver | ${volume.driver} |`,
        `| Mountpoint | ${volume.mountpoint || "N/A"} |`,
      ].join("\n"),
    );
  }
}

// ──────────────────────── Volume Provider ──────────────────────

export class VolumeProvider implements vscode.TreeDataProvider<VolumeTreeItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<VolumeTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private bcService: BcContainerService) {}

  getTreeItem(element: VolumeTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<VolumeTreeItem[]> {
    try {
      const volumes = await this.bcService.getVolumes();
      return volumes.map((v) => new VolumeTreeItem(v));
    } catch {
      return [];
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
