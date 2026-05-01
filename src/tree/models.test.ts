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

// ─── ContainerTreeItem - partial BC labels ────────────────────────

describe("ContainerTreeItem - partial BC labels", () => {
  it("container with nav but no country includes version without country", () => {
    const item = new ContainerTreeItem(
      makeContainer({ labels: { nav: "25.0.12345.0" } })
    );

    expect(item.description).toContain("BC 25.0.12345.0");
    expect(item.description).not.toMatch(/\| US/i);
  });

  it("container with country but no nav includes country without version", () => {
    const item = new ContainerTreeItem(
      makeContainer({ labels: { country: "us" } })
    );

    expect(item.description).toContain("US");
    expect(item.description).not.toContain("BC ");
  });

  it("container with platform label has platform in tooltip", () => {
    const item = new ContainerTreeItem(
      makeContainer({ labels: { nav: "25.0.12345.0", platform: "25.0.12000.0" } })
    );
    const md = (item.tooltip as vscode.MarkdownString).value;

    expect(md).toContain("25.0.12000.0");
  });

  it("container with nav + country + platform has all three in BC section", () => {
    const item = new ContainerTreeItem(
      makeContainer({
        labels: { nav: "25.0.12345.0", country: "us", platform: "25.0.12000.0" },
      })
    );
    const md = (item.tooltip as vscode.MarkdownString).value;

    expect(md).toContain("Business Central");
    expect(md).toContain("25.0.12345.0");
    expect(md).toContain("us");
    expect(md).toContain("25.0.12000.0");
  });
});

// ─── ContainerTreeItem - tooltip without BC labels ────────────────

describe("ContainerTreeItem - tooltip without BC labels", () => {
  it("container with empty labels omits Business Central section", () => {
    const item = new ContainerTreeItem(makeContainer({ labels: {} }));
    const md = (item.tooltip as vscode.MarkdownString).value;

    expect(md).not.toContain("Business Central");
  });

  it("tooltip still contains basic fields when no BC labels", () => {
    const item = new ContainerTreeItem(makeContainer({ labels: {} }));
    const md = (item.tooltip as vscode.MarkdownString).value;

    expect(md).toContain("mcr.microsoft.com/businesscentral:ltsc2022");
    expect(md).toContain("Up 2 hours");
    expect(md).toContain("0.0.0.0:443->443/tcp");
    expect(md).toContain("abc123");
    expect(md).toContain("2024-01-01 12:00:00");
  });
});

// ─── ContainerTreeItem - state variations ─────────────────────────

describe("ContainerTreeItem - state variations", () => {
  it("state 'created' is stoppedContainer context", () => {
    const item = new ContainerTreeItem(
      makeContainer({ state: "created", status: "Created" })
    );

    expect(item.contextValue).toBe("stoppedContainer");
  });

  it("state 'paused' is stoppedContainer context", () => {
    const item = new ContainerTreeItem(
      makeContainer({ state: "paused", status: "Up 2 hours (Paused)" })
    );

    expect(item.contextValue).toBe("stoppedContainer");
  });

  it("state 'RUNNING' (uppercase) is runningContainer context", () => {
    const item = new ContainerTreeItem(
      makeContainer({ state: "RUNNING" })
    );

    expect(item.contextValue).toBe("runningContainer");
  });
});

// ─── ImageTreeItem - additional checks ────────────────────────────

describe("ImageTreeItem - additional checks", () => {
  it("contextValue is always 'image'", () => {
    const item = new ImageTreeItem(makeImage());

    expect(item.contextValue).toBe("image");
  });

  it("iconPath is a ThemeIcon with id 'package'", () => {
    const item = new ImageTreeItem(makeImage());

    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe("package");
  });

  it("image with very long repository name uses full repo:tag as label", () => {
    const longRepo = "registry.example.com/very/deeply/nested/repository/path/image";
    const item = new ImageTreeItem(makeImage({ repository: longRepo, tag: "latest" }));

    expect(item.label).toBe(`${longRepo}:latest`);
  });

  it("image with tag '<none>' but valid repository shows repo:<none>", () => {
    const item = new ImageTreeItem(
      makeImage({ repository: "myrepo", tag: "<none>" })
    );

    expect(item.label).toBe("myrepo:<none>");
  });

  it("image with empty size has empty description", () => {
    const item = new ImageTreeItem(makeImage({ size: "" }));

    expect(item.description).toBe("");
  });

  it("image with empty createdAt renders tooltip without error", () => {
    const item = new ImageTreeItem(makeImage({ createdAt: "" }));

    expect(item.tooltip).toBeInstanceOf(vscode.MarkdownString);
    const md = (item.tooltip as vscode.MarkdownString).value;
    expect(md).toContain("mcr.microsoft.com/businesscentral");
  });
});

// ─── ContainerTreeItem - empty/missing ports ──────────────────────

describe("ContainerTreeItem - empty/missing ports", () => {
  it("container with empty ports shows 'none' in tooltip", () => {
    const item = new ContainerTreeItem(makeContainer({ ports: "" }));
    const md = (item.tooltip as vscode.MarkdownString).value;

    expect(md).toContain("none");
  });

  it("container with actual port mapping shows port string in tooltip", () => {
    const item = new ContainerTreeItem(
      makeContainer({ ports: "0.0.0.0:8080->80/tcp" })
    );
    const md = (item.tooltip as vscode.MarkdownString).value;

    expect(md).toContain("0.0.0.0:8080->80/tcp");
  });
});

// ─── ContainerTreeItem - annotations ─────────────────────────────

describe("ContainerTreeItem - annotations", () => {
  it("tags appear in description when annotation has tags", () => {
    const item = new ContainerTreeItem(makeContainer(), { tags: ["client1", "sandbox"] });

    expect(item.description).toContain("#client1");
    expect(item.description).toContain("#sandbox");
  });

  it("note appears in tooltip when annotation has a note", () => {
    const item = new ContainerTreeItem(makeContainer(), { note: "main dev container" });
    const md = (item.tooltip as vscode.MarkdownString).value;

    expect(md).toContain("Note");
    expect(md).toContain("main dev container");
  });

  it("no annotation does not change description or tooltip", () => {
    const withAnnotation = new ContainerTreeItem(makeContainer());
    const withoutAnnotation = new ContainerTreeItem(makeContainer(), undefined);

    expect(withAnnotation.description).toBe(withoutAnnotation.description);
    expect((withAnnotation.tooltip as vscode.MarkdownString).value).toBe(
      (withoutAnnotation.tooltip as vscode.MarkdownString).value
    );
  });

  it("empty tags array does not append hash tags to description", () => {
    const item = new ContainerTreeItem(makeContainer(), { tags: [] });

    expect(item.description).not.toContain("#");
  });

  it("note and tags together render both in their correct places", () => {
    const item = new ContainerTreeItem(makeContainer(), {
      note: "important note",
      tags: ["prod", "bc25"],
    });

    expect(item.description).toContain("#prod");
    expect(item.description).toContain("#bc25");
    const md = (item.tooltip as vscode.MarkdownString).value;
    expect(md).toContain("important note");
  });
});
