import * as vscode from "vscode";
import {
  DockerContainer,
  DockerImage,
  BcContainerMeta,
  DockerService,
} from "../docker/dockerService";
import { ContainerAnnotation } from "../services/containerAnnotationService";

// ──────────────────────── Container Tree Item ──────────────────

/**
 * A tree node representing one Docker container.
 */
export class ContainerTreeItem extends vscode.TreeItem {
  public readonly bcMeta: BcContainerMeta;

  constructor(public readonly container: DockerContainer, annotation?: ContainerAnnotation) {
    super(container.names, vscode.TreeItemCollapsibleState.None);

    const isRunning = container.state.toLowerCase() === "running";

    this.contextValue = isRunning ? "runningContainer" : "stoppedContainer";

    this.iconPath = new vscode.ThemeIcon(
      isRunning ? "circle-filled" : "circle-outline",
      isRunning
        ? new vscode.ThemeColor("charts.green")
        : new vscode.ThemeColor("disabledForeground")
    );

    this.bcMeta = DockerService.extractBcMeta(container.labels);

    const parts: string[] = [];
    if (this.bcMeta.version) {
      parts.push(`BC ${this.bcMeta.version}`);
    }
    if (this.bcMeta.country) {
      parts.push(this.bcMeta.country.toUpperCase());
    }
    parts.push(container.status);
    if (annotation?.tags?.length) {
      parts.push(annotation.tags.map((t) => `#${t}`).join(" "));
    }
    this.description = parts.join(" | ");

    const lines: string[] = [
      `**${container.names}**`,
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Image | ${container.image} |`,
      `| Status | ${container.status} |`,
      `| Ports | ${container.ports || "none"} |`,
      `| ID | \`${container.id.substring(0, 12)}\` |`,
      `| Created | ${container.createdAt} |`,
    ];

    if (this.bcMeta.version) {
      lines.push("");
      lines.push("**Business Central**");
      lines.push("");
      lines.push(`| Field | Value |`);
      lines.push(`|-------|-------|`);
      lines.push(`| Version | ${this.bcMeta.version} |`);
      if (this.bcMeta.country) {
        lines.push(`| Country | ${this.bcMeta.country} |`);
      }
      if (this.bcMeta.platform) {
        lines.push(`| Platform | ${this.bcMeta.platform} |`);
      }
    }

    if (annotation?.note) {
      lines.push("");
      lines.push("**Note**");
      lines.push("");
      lines.push(annotation.note);
    }

    this.tooltip = new vscode.MarkdownString(lines.join("\n"));
  }
}

// ──────────────────────── Initializing Container Tree Item ────

/**
 * A placeholder tree node shown while a container is being created.
 * Displayed from the moment creation starts until the container is
 * confirmed ready, giving the user immediate visual feedback.
 */
export class InitializingContainerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly containerName: string,
    public readonly phase: string,
  ) {
    super(containerName, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "initializingContainer";
    this.iconPath = new vscode.ThemeIcon("loading~spin");
    this.description = phase;
    this.tooltip = new vscode.MarkdownString(
      `**${containerName}**\n\nInitializing: ${phase}`,
    );
  }
}

/**
 * A tree node representing one Docker image.
 */
export class ImageTreeItem extends vscode.TreeItem {
  constructor(public readonly image: DockerImage) {
    const label =
      image.repository === "<none>"
        ? `<untagged> ${image.id.substring(0, 19)}`
        : `${image.repository}:${image.tag}`;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "image";
    this.iconPath = new vscode.ThemeIcon("package");
    this.description = image.size;

    this.tooltip = new vscode.MarkdownString(
      [
        `**${image.repository}:${image.tag}**`,
        "",
        `| Field | Value |`,
        `|-------|-------|`,
        `| ID | \`${image.id.substring(0, 19)}\` |`,
        `| Size | ${image.size} |`,
        `| Created | ${image.createdAt} |`,
      ].join("\n")
    );
  }
}
