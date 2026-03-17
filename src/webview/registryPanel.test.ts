/**
 * Unit tests for RegistryPanel (Artifacts Explorer webview).
 *
 * Tests cover singleton management, message routing, data loading,
 * pagination (sendChunk), HTML generation, and dispose cleanup.
 */
import * as vscode from "vscode";
import { RegistryPanel } from "./registryPanel";

// ─── Mocks ──────────────────────────────────────────────────────

function createMockArtifacts(): any {
  return {
    getCountries: jest.fn().mockResolvedValue(["us", "ca", "w1"]),
    getLatestVersions: jest.fn().mockResolvedValue({
      versions: [makeVersion("27.0.0.1"), makeVersion("27.0.0.0")],
      totalCount: 2,
    }),
    getVersions: jest.fn().mockResolvedValue([
      makeVersion("27.0.0.1"),
      makeVersion("27.0.0.0"),
    ]),
    getMajorVersions: jest.fn().mockResolvedValue([27, 26, 25]),
    getVersionsByMajor: jest.fn().mockResolvedValue([
      makeVersion("27.0.0.1"),
      makeVersion("27.0.0.0"),
    ]),
  };
}

function createMockDocker(): any {
  return {
    createBcContainer: jest.fn().mockResolvedValue(undefined),
    waitForContainerReady: jest.fn().mockResolvedValue(true),
    setupContainerNetworking: jest.fn().mockResolvedValue(true),
  };
}

function makeVersion(version: string, country = "us", type = "sandbox") {
  const [major, minor] = version.split(".").map(Number);
  return {
    version,
    major: major || 27,
    minor: minor || 0,
    country,
    type,
    creationTime: "2024-01-01T00:00:00Z",
    artifactUrl: `https://cdn.example.com/${type}/${version}/${country}`,
  };
}

/** Capture the onDidReceiveMessage callback for sending messages to the panel. */
function getMessageHandler(): (msg: Record<string, unknown>) => void {
  const mock = (vscode.window.createWebviewPanel as jest.Mock);
  const panelMock = mock.mock.results[mock.mock.results.length - 1]?.value;
  const onMsg = panelMock?.webview?.onDidReceiveMessage as jest.Mock;
  return onMsg?.mock?.calls[0]?.[0];
}

function getPostedMessages(): Record<string, unknown>[] {
  const mock = (vscode.window.createWebviewPanel as jest.Mock);
  const panelMock = mock.mock.results[mock.mock.results.length - 1]?.value;
  return (panelMock?.webview?.postMessage as jest.Mock)?.mock?.calls?.map(
    (c: unknown[]) => c[0],
  ) ?? [];
}

// ─── Test setup ─────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  // Reset singleton
  (RegistryPanel as any)._instance = undefined;
});

afterEach(() => {
  jest.useRealTimers();
  // Cleanup singleton
  if ((RegistryPanel as any)._instance) {
    (RegistryPanel as any)._instance = undefined;
  }
});

// ─── Tests ──────────────────────────────────────────────────────

describe("RegistryPanel.show", () => {
  it("creates a webview panel on first call", () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "bcDockerManager.artifactsExplorer",
      "BC Artifacts Explorer",
      expect.anything(),
      expect.objectContaining({
        enableScripts: true,
        retainContextWhenHidden: true,
      }),
    );
  });

  it("reveals existing panel on subsequent calls (singleton)", () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);
    RegistryPanel.show(artifacts, docker, uri);

    // Only one panel created, second call reveals
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    const panelMock = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0].value;
    expect(panelMock.reveal).toHaveBeenCalled();
  });
});

describe("RegistryPanel HTML generation", () => {
  it("generates HTML with CSP, CSS, and JS references", () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const panelMock = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0].value;
    const html: string = panelMock.webview.html;

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("BC Artifacts Explorer");
    expect(html).toContain("searchInput");
    expect(html).toContain("countrySelect");
    expect(html).toContain("majorSelect");
    expect(html).toContain("dataTable");
    // Tabs
    expect(html).toContain("sandbox");
    expect(html).toContain("onprem");
  });
});

describe("RegistryPanel failsafe init", () => {
  it("initializes automatically after 2s if 'ready' not received", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    // Before timeout, no countries loaded
    expect(artifacts.getCountries).not.toHaveBeenCalled();

    // Fast-forward 2s failsafe
    jest.advanceTimersByTime(2000);

    // Need to flush microtasks for the async _initPanel
    await Promise.resolve();
    await Promise.resolve();

    expect(artifacts.getCountries).toHaveBeenCalledWith("sandbox");
  });
});

describe("RegistryPanel message handling", () => {
  it("handles 'ready' message by initializing panel", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    expect(handler).toBeDefined();

    await handler({ command: "ready" });

    expect(artifacts.getCountries).toHaveBeenCalledWith("sandbox");
  });

  it("handles 'copyUrl' by writing to clipboard", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    await handler({ command: "copyUrl", url: "https://cdn.example.com/test" });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("https://cdn.example.com/test");
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it("handles 'copyVersion' by writing to clipboard", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    await handler({ command: "copyVersion", version: "27.0.0.1" });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("27.0.0.1");
  });

  it("handles 'loadCountry' by fetching countries and versions", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    await handler({ command: "loadCountry", type: "onprem", country: "ca" });

    expect(artifacts.getCountries).toHaveBeenCalledWith("onprem");
    expect(artifacts.getMajorVersions).toHaveBeenCalledWith("onprem", "ca");
    expect(artifacts.getLatestVersions).toHaveBeenCalledWith("onprem", "ca", 50);
  });

  it("handles 'loadMajor' by fetching major-specific versions", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    await handler({ command: "loadMajor", type: "sandbox", country: "us", major: 27 });

    expect(artifacts.getVersionsByMajor).toHaveBeenCalledWith("sandbox", "us", 27);
  });
});

describe("RegistryPanel._sendChunk (pagination)", () => {
  it("sends paginated chunks from cache", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    // Pre-populate cache directly
    const instance = (RegistryPanel as any)._instance;
    const versions = Array.from({ length: 75 }, (_, i) =>
      makeVersion(`27.0.0.${i}`),
    );
    instance._cache.set("sandbox/us", versions);

    const handler = getMessageHandler();
    await handler({ command: "loadMore", type: "sandbox", country: "us", offset: 50 });

    const messages = getPostedMessages();
    const moreMsg = messages.find((m) => m.command === "moreVersions");
    expect(moreMsg).toBeDefined();
    expect((moreMsg as any).versions).toHaveLength(25);
    expect((moreMsg as any).totalCount).toBe(75);
    expect((moreMsg as any).hasMore).toBe(false);
    expect((moreMsg as any).offset).toBe(75);
  });

  it("does nothing when cache key not found", async () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    const postMock = (vscode.window.createWebviewPanel as jest.Mock).mock.results[0].value.webview.postMessage;
    postMock.mockClear();

    await handler({ command: "loadMore", type: "sandbox", country: "zz", offset: 0 });

    // No message posted for unknown cache key
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe("RegistryPanel.dispose", () => {
  it("clears singleton instance", () => {
    const artifacts = createMockArtifacts();
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    expect((RegistryPanel as any)._instance).toBeDefined();

    (RegistryPanel as any)._instance.dispose();

    expect((RegistryPanel as any)._instance).toBeUndefined();
  });
});

describe("RegistryPanel error handling", () => {
  it("posts error message when getCountries fails", async () => {
    const artifacts = createMockArtifacts();
    artifacts.getCountries.mockRejectedValue(new Error("Network error"));
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    await handler({ command: "ready" });

    const messages = getPostedMessages();
    const errMsg = messages.find((m) => m.command === "error");
    expect(errMsg).toBeDefined();
    expect((errMsg as any).message).toBe("Network error");
  });

  it("posts error when loadMajor fails", async () => {
    const artifacts = createMockArtifacts();
    artifacts.getVersionsByMajor.mockRejectedValue(new Error("CDN timeout"));
    const docker = createMockDocker();
    const uri = vscode.Uri.file("/ext");

    RegistryPanel.show(artifacts, docker, uri);

    const handler = getMessageHandler();
    await handler({ command: "loadMajor", type: "sandbox", country: "us", major: 27 });

    const messages = getPostedMessages();
    const errMsg = messages.find((m) => m.command === "error");
    expect(errMsg).toBeDefined();
    expect((errMsg as any).message).toBe("CDN timeout");
  });
});
