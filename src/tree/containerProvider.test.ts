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

// ─── toggleBcFilter — shows information message ─────────────────

describe("ContainerProvider.toggleBcFilter — shows information message", () => {
  const vscode = require("vscode");

  it("shows message containing OFF when filter is turned off", () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);

    provider.toggleBcFilter(); // ON → OFF
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("OFF")
    );
  });

  it("shows message containing ON when filter is turned back on", () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);

    provider.toggleBcFilter(); // ON → OFF
    (vscode.window.showInformationMessage as jest.Mock).mockClear();

    provider.toggleBcFilter(); // OFF → ON
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("ON")
    );
  });
});

// ─── getTreeItem ─────────────────────────────────────────────────

describe("ContainerProvider.getTreeItem", () => {
  it("returns the same element that was passed in", async () => {
    const mockDocker = createMockDocker();
    const provider = new ContainerProvider(mockDocker);
    const items = await provider.getChildren();

    const result = provider.getTreeItem(items[0]);

    expect(result).toBe(items[0]);
  });
});

// ─── getChildren — multiple containers ───────────────────────────

describe("ContainerProvider.getChildren — multiple containers", () => {
  it("returns 3 ContainerTreeItem instances for 3 containers", async () => {
    const containers: DockerContainer[] = [
      { ...sampleContainer, id: "c1", names: "/container1" },
      { ...sampleContainer, id: "c2", names: "/container2" },
      { ...sampleContainer, id: "c3", names: "/container3" },
    ];
    const mockDocker = createMockDocker();
    (mockDocker.getBcContainers as jest.Mock).mockResolvedValue(containers);
    const provider = new ContainerProvider(mockDocker);

    const children = await provider.getChildren();

    expect(children).toHaveLength(3);
    children.forEach((child, i) => {
      expect(child).toBeInstanceOf(ContainerTreeItem);
      expect(child.container).toEqual(containers[i]);
    });
  });
});

// ─── getChildren — mixed states ──────────────────────────────────

describe("ContainerProvider.getChildren — mixed states", () => {
  it("assigns correct contextValue for running and stopped containers", async () => {
    const runningContainer: DockerContainer = {
      ...sampleContainer,
      id: "r1",
      names: "/running-one",
      state: "running",
    };
    const stoppedContainer: DockerContainer = {
      ...sampleContainer,
      id: "s1",
      names: "/stopped-one",
      state: "exited",
      status: "Exited (0) 5 minutes ago",
    };
    const mockDocker = createMockDocker();
    (mockDocker.getBcContainers as jest.Mock).mockResolvedValue([
      runningContainer,
      stoppedContainer,
    ]);
    const provider = new ContainerProvider(mockDocker);

    const children = await provider.getChildren();

    expect(children).toHaveLength(2);
    expect(children[0].contextValue).toBe("runningContainer");
    expect(children[1].contextValue).toBe("stoppedContainer");
  });
});
