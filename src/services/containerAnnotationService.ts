import * as vscode from "vscode";

export interface ContainerAnnotation {
  note?: string;
  tags?: string[];
}

const STORAGE_KEY = "bcDockerManager.containerAnnotations";

/**
 * Persists per-container notes and tags in VS Code global state so they
 * survive container restarts, recreations, and VS Code restarts.
 *
 * All mutations are async and await the underlying Memento write before
 * returning, ensuring callers can rely on the stored state being durable.
 */
export class ContainerAnnotationService {
  constructor(private readonly state: vscode.Memento) {}

  get(containerName: string): ContainerAnnotation | undefined {
    return this.state
      .get<Record<string, ContainerAnnotation>>(STORAGE_KEY)?.[containerName];
  }

  async setNote(containerName: string, note: string): Promise<void> {
    await this._mutate(containerName, (ann) => ({
      ...ann,
      note: note.trim() || undefined,
    }));
  }

  async setTags(containerName: string, tags: string[]): Promise<void> {
    const cleaned = tags.map((t) => t.trim()).filter(Boolean);
    await this._mutate(containerName, (ann) => ({
      ...ann,
      tags: cleaned.length ? cleaned : undefined,
    }));
  }

  async clear(containerName: string): Promise<void> {
    const all = this._all();
    delete all[containerName];
    await this.state.update(STORAGE_KEY, all);
  }

  private _all(): Record<string, ContainerAnnotation> {
    return { ...(this.state.get<Record<string, ContainerAnnotation>>(STORAGE_KEY) ?? {}) };
  }

  private async _mutate(
    name: string,
    fn: (ann: ContainerAnnotation) => ContainerAnnotation
  ): Promise<void> {
    const all = this._all();
    const updated = fn(all[name] ?? {});
    if (updated.note === undefined && (updated.tags === undefined || updated.tags.length === 0)) {
      delete all[name];
    } else {
      all[name] = updated;
    }
    await this.state.update(STORAGE_KEY, all);
  }
}
