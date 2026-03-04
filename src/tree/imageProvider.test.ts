/**
 * Unit tests for ImageProvider.
 */

import { ImageProvider } from "./imageProvider";
import { ImageTreeItem } from "./models";
import { DockerService, DockerImage } from "../docker/dockerService";

jest.mock("../docker/dockerService");

// ─── Sample data ─────────────────────────────────────────────────

const sampleImage: DockerImage = {
  repository: "mcr.microsoft.com/businesscentral",
  tag: "ltsc2022",
  id: "sha256:abc123",
  size: "15.2GB",
  createdAt: "2024-01-01",
};

// ─── Helper ──────────────────────────────────────────────────────

function createMockDocker(overrides?: Partial<Record<"getImages" | "getBcImages", jest.Mock>>) {
  return {
    getImages: jest.fn().mockResolvedValue([sampleImage]),
    getBcImages: jest.fn().mockResolvedValue([sampleImage]),
    ...overrides,
  } as unknown as DockerService;
}

// ─── getChildren ─────────────────────────────────────────────────

describe("ImageProvider.getChildren", () => {
  it("returns ImageTreeItem[] when docker returns images", async () => {
    const provider = new ImageProvider(createMockDocker());
    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ImageTreeItem);
    expect(children[0].image).toBe(sampleImage);
  });

  it("returns empty array when docker returns empty list", async () => {
    const mock = createMockDocker({
      getBcImages: jest.fn().mockResolvedValue([]),
    });
    const provider = new ImageProvider(mock);
    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });

  it("returns empty array when docker throws (error suppression)", async () => {
    const mock = createMockDocker({
      getBcImages: jest.fn().mockRejectedValue(new Error("Docker not running")),
    });
    const provider = new ImageProvider(mock);
    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });
});

// ─── BC filter routing ───────────────────────────────────────────

describe("ImageProvider BC filter routing", () => {
  it("calls getBcImages() when BC filter is ON (default)", async () => {
    const mock = createMockDocker();
    const provider = new ImageProvider(mock);
    await provider.getChildren();

    expect(mock.getBcImages).toHaveBeenCalled();
    expect(mock.getImages).not.toHaveBeenCalled();
  });

  it("calls getImages() when BC filter is OFF", async () => {
    const mock = createMockDocker();
    const provider = new ImageProvider(mock);
    provider.toggleBcFilter(); // turn OFF
    await provider.getChildren();

    expect(mock.getImages).toHaveBeenCalled();
    expect(mock.getBcImages).not.toHaveBeenCalled();
  });
});

// ─── toggleBcFilter ──────────────────────────────────────────────

describe("ImageProvider.toggleBcFilter", () => {
  it("flips bcFilterEnabled", () => {
    const provider = new ImageProvider(createMockDocker());
    expect(provider.bcFilterEnabled).toBe(true);

    provider.toggleBcFilter();
    expect(provider.bcFilterEnabled).toBe(false);
  });

  it("double toggle returns to original state", () => {
    const provider = new ImageProvider(createMockDocker());
    provider.toggleBcFilter();
    provider.toggleBcFilter();

    expect(provider.bcFilterEnabled).toBe(true);
  });
});

// ─── refresh ─────────────────────────────────────────────────────

describe("ImageProvider.refresh", () => {
  it("fires the onDidChangeTreeData event", () => {
    const provider = new ImageProvider(createMockDocker());

    // Access the internal EventEmitter to verify fire() is called
    const emitter = (provider as any)._onDidChangeTreeData;
    provider.refresh();

    expect(emitter.fire).toHaveBeenCalled();
  });
});
