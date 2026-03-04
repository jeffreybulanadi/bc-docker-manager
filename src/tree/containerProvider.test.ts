/**
 * Unit tests for ContainerProvider.
 */

import { ContainerProvider } from "./containerProvider";
import { ContainerTreeItem } from "./models";
import { DockerService, DockerContainer } from "../docker/dockerService";

jest.mock("../docker/dockerService", () => {
  const actual = jest.requireActual("../docker/dockerService");
  return {
    ...actual,
    DockerService: Object.assign(jest.fn(), {
      extractBcMeta: actual.DockerService.extractBcMeta,
      isBcContainer: actual.DockerService.isBcContainer,
    }),
  };
});

// ─── Sample data ─────────────────────────────────────────────────

const sampleContainer: DockerContainer = {
  id: "abc123",
  names: "/mybc",
  image: "mcr.microsoft.com/businesscentral:ltsc2022",
  status: "Up 2 hours",
  state: "running",
  ports: "443/tcp",
  createdAt: "2024-01-01",
  labels: { maintainer: "Dynamics SMB", nav: "25.0.0.0" },
};

// ─── Mock DockerService ──────────────────────────────────────────

function createMockDocker() {
  return {
    getContainers: jest.fn().mockResolvedValue([sampleContainer]),
    getBcContainers: jest.fn().mockResolvedValue([sampleContainer]),
  } as unknown as DockerService;
}

// ─── getChildren ─────────────────────────────────────────────────

describe("ContainerProvider.getChildren", () => {
  it("returns ContainerTreeItem[] when docker returns containers", async () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);

    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ContainerTreeItem);
    expect(children[0].container).toEqual(sampleContainer);
  });

  it("returns empty array when docker returns empty list", async () => {
    const mockDocker = createMockDocker();
    (mockDocker.getBcContainers as jest.Mock).mockResolvedValue([]);
    const provider = new ContainerProvider(mockDocker);

    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });

  it("returns empty array when docker throws (error suppression)", async () => {
    const mockDocker = createMockDocker();
    (mockDocker.getBcContainers as jest.Mock).mockRejectedValue(
      new Error("Docker not available")
    );
    const provider = new ContainerProvider(mockDocker);

    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });
});

// ─── getChildren with BC filter ──────────────────────────────────

describe("ContainerProvider.getChildren BC filter", () => {
  it("calls getBcContainers when BC filter is ON (default)", async () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);

    await provider.getChildren();

    expect(mockDocker.getBcContainers).toHaveBeenCalled();
    expect(mockDocker.getContainers).not.toHaveBeenCalled();
  });

  it("calls getContainers when BC filter is OFF", async () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);
    provider.toggleBcFilter(); // turn OFF

    await provider.getChildren();

    expect(mockDocker.getContainers).toHaveBeenCalled();
  });
});

// ─── toggleBcFilter ──────────────────────────────────────────────

describe("ContainerProvider.toggleBcFilter", () => {
  it("flips bcFilterEnabled from initial state", () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);

    expect(provider.bcFilterEnabled).toBe(true);
    provider.toggleBcFilter();
    expect(provider.bcFilterEnabled).toBe(false);
  });

  it("calling twice returns to original state", () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);

    provider.toggleBcFilter();
    provider.toggleBcFilter();
    expect(provider.bcFilterEnabled).toBe(true);
  });
});

// ─── refresh ─────────────────────────────────────────────────────

describe("ContainerProvider.refresh", () => {
  it("fires onDidChangeTreeData event", () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);

    provider.refresh();

    // The EventEmitter mock from vscode-mock.ts exposes `fire` as a jest.fn()
    // Access the underlying emitter via the provider's internal field.
    expect((provider as any)._onDidChangeTreeData.fire).toHaveBeenCalled();
  });
});
