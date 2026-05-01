/**
 * Unit tests for VolumeProvider.
 */

import { VolumeProvider, VolumeTreeItem } from "./volumeProvider";
import { BcContainerService, DockerVolume } from "../docker/bcContainerService";

jest.mock("../docker/bcContainerService");

// ─── Sample data ─────────────────────────────────────────────────

function makeVolume(overrides: Partial<DockerVolume> = {}): DockerVolume {
  return {
    name: "bc-my-sandbox-my-db",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/bc-my-sandbox-my-db/_data",
    ...overrides,
  };
}

// ─── Helper ──────────────────────────────────────────────────────

function createMockBcService(overrides?: Partial<Record<"getVolumes", jest.Mock>>) {
  return {
    getVolumes: jest.fn().mockResolvedValue([makeVolume()]),
    ...overrides,
  } as unknown as BcContainerService;
}

// ─── VolumeTreeItem ──────────────────────────────────────────────

describe("VolumeTreeItem", () => {
  it("sets label to volume name", () => {
    const vol = makeVolume({ name: "my-volume" });
    const item = new VolumeTreeItem(vol);

    expect(item.label).toBe("my-volume");
  });

  it("sets contextValue to 'volume'", () => {
    const item = new VolumeTreeItem(makeVolume());

    expect(item.contextValue).toBe("volume");
  });

  it("sets icon to 'database' ThemeIcon", () => {
    const item = new VolumeTreeItem(makeVolume());

    expect(item.iconPath).toBeDefined();
    expect(item.iconPath.id).toBe("database");
  });

  it("sets description to driver name", () => {
    const item = new VolumeTreeItem(makeVolume({ driver: "overlay2" }));

    expect(item.description).toBe("overlay2");
  });

  it("generates markdown tooltip with name, driver, mountpoint", () => {
    const vol = makeVolume({
      name: "my-vol",
      driver: "local",
      mountpoint: "/mnt/data",
    });
    const item = new VolumeTreeItem(vol);

    expect(item.tooltip).toBeDefined();
    const md = item.tooltip.value as string;
    expect(md).toContain("**my-vol**");
    expect(md).toContain("local");
    expect(md).toContain("/mnt/data");
  });

  it("handles empty mountpoint (shows 'N/A')", () => {
    const vol = makeVolume({ mountpoint: "" });
    const item = new VolumeTreeItem(vol);

    const md = item.tooltip.value as string;
    expect(md).toContain("N/A");
  });
});

// ─── getTreeItem ─────────────────────────────────────────────────

describe("VolumeProvider.getTreeItem", () => {
  it("returns the same element that was passed in", async () => {
    const provider = new VolumeProvider(createMockBcService());
    const items = await provider.getChildren();
    const result = provider.getTreeItem(items[0]);

    expect(result).toBe(items[0]);
  });
});

// ─── getChildren ─────────────────────────────────────────────────

describe("VolumeProvider.getChildren", () => {
  it("returns VolumeTreeItem[] from bcService.getVolumes()", async () => {
    const provider = new VolumeProvider(createMockBcService());
    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(VolumeTreeItem);
    expect(children[0].volume).toEqual(makeVolume());
  });

  it("returns empty array when no volumes", async () => {
    const mock = createMockBcService({
      getVolumes: jest.fn().mockResolvedValue([]),
    });
    const provider = new VolumeProvider(mock);
    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });

  it("returns empty array on error (error suppression)", async () => {
    const mock = createMockBcService({
      getVolumes: jest.fn().mockRejectedValue(new Error("Docker not running")),
    });
    const provider = new VolumeProvider(mock);
    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });
});

// ─── refresh ─────────────────────────────────────────────────────

describe("VolumeProvider.refresh", () => {
  it("fires the onDidChangeTreeData event", () => {
    const provider = new VolumeProvider(createMockBcService());
    const emitter = (provider as any)._onDidChangeTreeData;

    provider.refresh();

    expect(emitter.fire).toHaveBeenCalled();
  });
});

// ─── getChildren - multiple volumes ──────────────────────────────

describe("VolumeProvider.getChildren - multiple volumes", () => {
  const volumes: DockerVolume[] = [
    { name: "vol-alpha", driver: "local", mountpoint: "/mnt/alpha" },
    { name: "vol-beta", driver: "overlay2", mountpoint: "/mnt/beta" },
    { name: "vol-gamma", driver: "local", mountpoint: "" },
  ];

  it("returns 3 VolumeTreeItem instances for 3 volumes", async () => {
    const mock = createMockBcService({
      getVolumes: jest.fn().mockResolvedValue(volumes),
    });
    const provider = new VolumeProvider(mock);
    const children = await provider.getChildren();

    expect(children).toHaveLength(3);
    children.forEach((child) => expect(child).toBeInstanceOf(VolumeTreeItem));
  });

  it("each item preserves its volume data", async () => {
    const mock = createMockBcService({
      getVolumes: jest.fn().mockResolvedValue(volumes),
    });
    const provider = new VolumeProvider(mock);
    const children = await provider.getChildren();

    expect(children[0].volume).toBe(volumes[0]);
    expect(children[1].volume).toBe(volumes[1]);
    expect(children[2].volume).toBe(volumes[2]);
  });
});
