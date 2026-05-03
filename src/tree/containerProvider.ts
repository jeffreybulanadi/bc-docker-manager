import * as vscode from "vscode";
import { DockerService } from "../docker/dockerService";
import { ContainerTreeItem, InitializingContainerTreeItem } from "./models";
import { ContainerAnnotationService } from "../services/containerAnnotationService";
import { debounce } from "../util/debounce";

/**
 * Provides container data for the "Containers" tree view.
 *
 * BC filter (default ON) uses `docker ps --filter "label=nav"` plus
 * an image-name fallback - no external modules required.
 *
 * Phase tracking: callers can call `setContainerPhase` / `clearContainerPhase`
 * to drive live status updates during container initialization. The provider
 * renders a placeholder item while the container does not yet exist in Docker,
 * then overlays the phase label on the real item once Docker reports it.
 */
export class ContainerProvider
  implements vscode.TreeDataProvider<ContainerTreeItem | InitializingContainerTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ContainerTreeItem | InitializingContainerTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _bcFilterEnabled = true;

  /** name (without leading slash) -> current phase label */
  private readonly _initializingContainers = new Map<string, string>();

  private readonly _debouncedFire = debounce(() => {
    this._onDidChangeTreeData.fire();
  }, 150);

  constructor(
    private readonly docker: DockerService,
    private readonly annotations?: ContainerAnnotationService
  ) {}

  dispose(): void {
    this._debouncedFire.cancel();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: ContainerTreeItem | InitializingContainerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<(ContainerTreeItem | InitializingContainerTreeItem)[]> {
    try {
      const containers = this._bcFilterEnabled
        ? await this.docker.getBcContainers()
        : await this.docker.getContainers();

      // Normalize Docker names (may have a leading "/") for lookup.
      const realNames = new Set(
        containers.map((c) => c.names.replace(/^\//, "")),
      );

      const result: (ContainerTreeItem | InitializingContainerTreeItem)[] = [];

      // Placeholder items for containers not yet visible in Docker.
      for (const [name, phase] of this._initializingContainers) {
        if (!realNames.has(name)) {
          result.push(new InitializingContainerTreeItem(name, phase));
        }
      }

      // Real container items, with phase overlay while still initializing.
      for (const c of containers) {
        const name = c.names.replace(/^\//, "");
        const annotation = this.annotations?.get(name);
        const item = new ContainerTreeItem(c, annotation);
        const phase = this._initializingContainers.get(name);
        if (phase) {
          item.description = phase;
          item.iconPath = new vscode.ThemeIcon("loading~spin");
        }
        result.push(item);
      }

      return result;
    } catch {
      // Docker not available - return empty list silently.
      // The activity bar welcome view will guide the user.
      return [];
    }
  }

  refresh(): void {
    this._debouncedFire();
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

  /**
   * Record that a container is initializing at the given phase.
   * Fires a tree refresh so the placeholder or phase label appears immediately.
   */
  setContainerPhase(name: string, phase: string): void {
    this._initializingContainers.set(name, phase);
    this._onDidChangeTreeData.fire();
  }

  /**
   * Remove the initializing state for a container once it is fully ready.
   * Fires a tree refresh to restore the normal container item appearance.
   */
  clearContainerPhase(name: string): void {
    this._initializingContainers.delete(name);
    this._onDidChangeTreeData.fire();
  }
}
