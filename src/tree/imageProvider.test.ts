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

// ─── getTreeItem ─────────────────────────────────────────────────

describe("ImageProvider.getTreeItem", () => {
  it("returns the same element that was passed in", async () => {
    const provider = new ImageProvider(createMockDocker());
    const items = await provider.getChildren();
    const result = provider.getTreeItem(items[0]);
    expect(result).toBe(items[0]);
  });
});

// ─── getChildren - multiple images ───────────────────────────────

describe("ImageProvider.getChildren - multiple images", () => {
  const images: DockerImage[] = [
    { repository: "mcr.microsoft.com/businesscentral", tag: "ltsc2022", id: "sha256:aaa", size: "10GB", createdAt: "2024-01-01" },
    { repository: "mcr.microsoft.com/businesscentral", tag: "ltsc2019", id: "sha256:bbb", size: "12GB", createdAt: "2024-01-02" },
    { repository: "myregistry/bc", tag: "v1", id: "sha256:ccc", size: "8GB", createdAt: "2024-01-03" },
  ];

  it("returns 3 ImageTreeItem instances for 3 images", async () => {
    const mock = createMockDocker({
      getBcImages: jest.fn().mockResolvedValue(images),
    });
    const provider = new ImageProvider(mock);
    const children = await provider.getChildren();

    expect(children).toHaveLength(3);
    children.forEach((child) => expect(child).toBeInstanceOf(ImageTreeItem));
  });

  it("each item preserves its image data", async () => {
    const mock = createMockDocker({
      getBcImages: jest.fn().mockResolvedValue(images),
    });
    const provider = new ImageProvider(mock);
    const children = await provider.getChildren();

    expect(children[0].image).toBe(images[0]);
    expect(children[1].image).toBe(images[1]);
    expect(children[2].image).toBe(images[2]);
  });
});

// ─── getChildren - untagged images ───────────────────────────────

describe("ImageProvider.getChildren - untagged images", () => {
  const untaggedImage: DockerImage = {
    repository: "<none>",
    tag: "<none>",
    id: "sha256:deadbeef1234567890",
    size: "5GB",
    createdAt: "2024-02-01",
  };

  it("BC filter ON: getBcImages returns empty (untagged filtered out)", async () => {
    const mock = createMockDocker({
      getBcImages: jest.fn().mockResolvedValue([]),
      getImages: jest.fn().mockResolvedValue([untaggedImage]),
    });
    const provider = new ImageProvider(mock);
    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });

  it("BC filter OFF: getImages returns the untagged image, label contains '<untagged>'", async () => {
    const mock = createMockDocker({
      getBcImages: jest.fn().mockResolvedValue([]),
      getImages: jest.fn().mockResolvedValue([untaggedImage]),
    });
    const provider = new ImageProvider(mock);
    provider.toggleBcFilter();
    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect((children[0] as any).label).toContain("<untagged>");
    expect(children[0].image).toBe(untaggedImage);
  });
});

// ─── refresh fires event after toggle ────────────────────────────

describe("ImageProvider - refresh fires event after toggle", () => {
  it("toggleBcFilter implicitly calls refresh - event emitter fires", () => {
    const provider = new ImageProvider(createMockDocker());
    const emitter = (provider as any)._onDidChangeTreeData;

    emitter.fire.mockClear();
    provider.toggleBcFilter();

    expect(emitter.fire).toHaveBeenCalled();
  });
});
