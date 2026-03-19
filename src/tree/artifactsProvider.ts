import * as vscode from "vscode";
import {
  BcArtifactsService,
  BcArtifactVersion,
} from "../registry/bcArtifactsService";

// ────────────────────────── Tree Items ──────────────────────────

export class ArtifactTreeItem extends vscode.TreeItem {
  constructor(public readonly artifact: BcArtifactVersion) {
    super(`BC ${artifact.major}.${artifact.minor}`, vscode.TreeItemCollapsibleState.None);

    this.description = artifact.version;

    this.iconPath = new vscode.ThemeIcon(
      "cloud-download",
      new vscode.ThemeColor("charts.blue"),
    );

    const date = artifact.creationTime
      ? new Date(artifact.creationTime).toLocaleDateString()
      : "—";

    this.tooltip = new vscode.MarkdownString([
      `**${artifact.version}**`,
      "",
      `Type: ${artifact.type}`,
      `Country: ${artifact.country.toUpperCase()}`,
      `Published: ${date}`,
    ].join("\n"));
  }
}

export class BrowseAllTreeItem extends vscode.TreeItem {
  constructor(totalCount: number) {
    super("Browse All Artifacts →", vscode.TreeItemCollapsibleState.None);
    this.description = `${totalCount} available`;
    this.iconPath = new vscode.ThemeIcon("globe");
    this.contextValue = "browseAll";
    this.command = {
      title: "Open BC Artifacts Explorer",
      command: "bcDockerManager.openExplorer",
    };
  }
}

// ────────────────────────── Provider ───────────────────────────

/**
 * Tree data provider showing the latest 5 BC artifacts with a
 * "Browse All →" item that opens the full webview explorer.
 */
export class ArtifactsProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private static readonly PREVIEW_COUNT = 5;

  constructor(private readonly _artifacts: BcArtifactsService) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      const { versions, totalCount } = await this._artifacts.getLatestVersions(
        "sandbox",
        "us",
        ArtifactsProvider.PREVIEW_COUNT,
      );

      const items: vscode.TreeItem[] = versions.map(
        (v) => new ArtifactTreeItem(v),
      );

      items.push(new BrowseAllTreeItem(totalCount));

      return items;
    } catch {
      // Service unavailable — show a fallback item to open the explorer
      const fallback = new vscode.TreeItem("Open BC Artifacts Explorer");
      fallback.iconPath = new vscode.ThemeIcon("globe");
      fallback.command = {
        title: "Open BC Artifacts Explorer",
        command: "bcDockerManager.openExplorer",
      };
      return [fallback];
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
