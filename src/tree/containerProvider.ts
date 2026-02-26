import * as vscode from "vscode";
import { DockerService } from "../docker/dockerService";
import { ContainerTreeItem } from "./models";

/**
 * Provides container data for the "Containers" tree view.
 *
 * BC filter (default ON) uses `docker ps --filter "label=nav"` plus
 * an image-name fallback — no external modules required.
 */
export class ContainerProvider
  implements vscode.TreeDataProvider<ContainerTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ContainerTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _bcFilterEnabled = true;

  constructor(private readonly docker: DockerService) {}

  getTreeItem(element: ContainerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ContainerTreeItem[]> {
    try {
      const containers = this._bcFilterEnabled
        ? await this.docker.getBcContainers()
        : await this.docker.getContainers();

      return containers.map((c) => new ContainerTreeItem(c));
    } catch {
      // Docker not available — return empty list silently.
      // The activity bar welcome view will guide the user.
      return [];
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  toggleBcFilter(): void {
    this._bcFilterEnabled = !this._bcFilterEnabled;
    const state = this._bcFilterEnabled ? "ON (BC only)" : "OFF (all)";
    vscode.window.showInformationMessage(`BC filter: ${state}`);
    this.refresh();
  }

  get bcFilterEnabled(): boolean {
    return this._bcFilterEnabled;
  }
}
