/**
 * Unit tests for ContainerTreeItem and ImageTreeItem.
 */

import * as vscode from "vscode";
import { ContainerTreeItem, ImageTreeItem } from "./models";
import { DockerContainer, DockerImage } from "../docker/dockerService";

// ─── helpers ─────────────────────────────────────────────────────

function makeContainer(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "abc123",
    names: "/mybc",
    image: "mcr.microsoft.com/businesscentral:ltsc2022",
    status: "Up 2 hours",
    state: "running",
    ports: "0.0.0.0:443->443/tcp",
    createdAt: "2024-01-01 12:00:00",
    labels: { nav: "25.0.12345.0", country: "us", maintainer: "Dynamics SMB" },
    ...overrides,
  };
}

function makeImage(overrides: Partial<DockerImage> = {}): DockerImage {
  return {
    repository: "mcr.microsoft.com/businesscentral",
    tag: "ltsc2022",
    id: "sha256:abc123def456",
    size: "15.2GB",
    createdAt: "2024-01-01 12:00:00",
    ...overrides,
  };
}

// ─── ContainerTreeItem ───────────────────────────────────────────

describe("ContainerTreeItem", () => {
  it("running container has correct label, contextValue, and green icon", () => {
    const item = new ContainerTreeItem(makeContainer());

    expect(item.label).toBe("/mybc");
    expect(item.contextValue).toBe("runningContainer");
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe("circle-filled");
    expect((item.iconPath as any).color.id).toBe("charts.green");
  });

  it("stopped container has correct contextValue and gray icon", () => {
    const item = new ContainerTreeItem(
      makeContainer({ state: "exited", status: "Exited (0) 5 minutes ago" })
    );

    expect(item.contextValue).toBe("stoppedContainer");
    expect((item.iconPath as vscode.ThemeIcon).id).toBe("circle-outline");
    expect((item.iconPath as any).color.id).toBe("disabledForeground");
  });

  it("container with BC labels includes version and country in description", () => {
    const item = new ContainerTreeItem(makeContainer());

    expect(item.description).toContain("BC 25.0.12345.0");
    expect(item.description).toContain("US");
  });

  it("container without BC labels omits version info in description", () => {
    const item = new ContainerTreeItem(makeContainer({ labels: {} }));

    expect(item.description).not.toContain("BC ");
    expect(item.description).toBe("Up 2 hours");
  });

  it("tooltip is a MarkdownString with container details", () => {
    const item = new ContainerTreeItem(makeContainer());

    expect(item.tooltip).toBeInstanceOf(vscode.MarkdownString);
    const md = (item.tooltip as vscode.MarkdownString).value;
    expect(md).toContain("/mybc");
    expect(md).toContain("abc123");
    expect(md).toContain("Up 2 hours");
    expect(md).toContain("0.0.0.0:443->443/tcp");
  });

  it("uses container names string as label (including leading /)", () => {
    const item = new ContainerTreeItem(makeContainer({ names: "/first-container" }));

    expect(item.label).toBe("/first-container");
  });
});

// ─── ImageTreeItem ───────────────────────────────────────────────

describe("ImageTreeItem", () => {
  it("tagged image label is repository:tag", () => {
    const item = new ImageTreeItem(makeImage());

    expect(item.label).toBe("mcr.microsoft.com/businesscentral:ltsc2022");
  });

  it("untagged image label contains <untagged> and shortened ID", () => {
    const item = new ImageTreeItem(
      makeImage({ repository: "<none>", tag: "<none>", id: "sha256:abc123def456" })
    );

    expect(item.label).toContain("<untagged>");
    expect(item.label).toContain("sha256:abc123def456".substring(0, 19));
  });

  it("description is the image size", () => {
    const item = new ImageTreeItem(makeImage());

    expect(item.description).toBe("15.2GB");
  });

  it("tooltip is a MarkdownString with image details", () => {
    const item = new ImageTreeItem(makeImage());

    expect(item.tooltip).toBeInstanceOf(vscode.MarkdownString);
    const md = (item.tooltip as vscode.MarkdownString).value;
    expect(md).toContain("mcr.microsoft.com/businesscentral");
    expect(md).toContain("15.2GB");
    expect(md).toContain("2024-01-01 12:00:00");
  });
});
