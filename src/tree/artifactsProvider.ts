import * as vscode from "vscode";

// ────────────────────────── Tree Items ──────────────────────────

class BrowseArtifactsItem extends vscode.TreeItem {
  constructor() {
    super("Browse BC Artifacts", vscode.TreeItemCollapsibleState.None);
    this.description = "sandbox · onprem";
    this.iconPath = new vscode.ThemeIcon("globe");
    this.command = {
      title: "Open BC Artifacts Explorer",
      command: "bcDockerManager.openExplorer",
    };
  }
}

// ────────────────────────── Provider ───────────────────────────

/**
 * Minimal tree provider showing a single "Browse BC Artifacts" item
 * that opens the full webview explorer on click.
 */
export class ArtifactsProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    return [new BrowseArtifactsItem()];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
