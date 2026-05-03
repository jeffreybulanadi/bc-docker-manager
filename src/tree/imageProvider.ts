import * as vscode from "vscode";
import { DockerService } from "../docker/dockerService";
import { ImageTreeItem } from "./models";
import { debounce } from "../util/debounce";

/**
 * Provides image data for the "Images" tree view.
 *
 * BC filter (default ON) shows only images whose repository
 * contains "businesscentral" or a "bc" segment.
 */
export class ImageProvider
  implements vscode.TreeDataProvider<ImageTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ImageTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _bcFilterEnabled = true;

  private readonly _debouncedFire = debounce(() => {
    this._onDidChangeTreeData.fire();
  }, 150);

  constructor(private readonly docker: DockerService) {}

  dispose(): void {
    this._debouncedFire.cancel();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: ImageTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ImageTreeItem[]> {
    try {
      const images = this._bcFilterEnabled
        ? await this.docker.getBcImages()
        : await this.docker.getImages();

      return images.map((img) => new ImageTreeItem(img));
    } catch {
      // Docker not available - return empty list silently.
      return [];
    }
  }

  refresh(): void {
    this._debouncedFire();
  }

  toggleBcFilter(): void {
    this._bcFilterEnabled = !this._bcFilterEnabled;
    this.refresh();
  }

  get bcFilterEnabled(): boolean {
    return this._bcFilterEnabled;
  }
}
