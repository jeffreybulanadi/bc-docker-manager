/**
 * Unit tests for ContainerAnnotationService.
 */

import { ContainerAnnotationService, ContainerAnnotation } from "./containerAnnotationService";

// ─── Minimal vscode.Memento stub ─────────────────────────────────

function makeMementoStub(): { store: Record<string, unknown>; get: jest.Mock; update: jest.Mock } {
  const store: Record<string, unknown> = {};
  return {
    store,
    get: jest.fn((key: string) => store[key]),
    update: jest.fn(async (key: string, value: unknown) => {
      store[key] = value;
    }),
  };
}

// ─── ContainerAnnotationService ──────────────────────────────────

describe("ContainerAnnotationService", () => {
  it("returns undefined for a container with no annotation", () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    expect(svc.get("bc25us")).toBeUndefined();
  });

  it("stores and retrieves a note", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setNote("bc25us", "client ABC prod container");

    expect(svc.get("bc25us")).toEqual({ note: "client ABC prod container" });
  });

  it("stores and retrieves tags", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setTags("bc25us", ["client1", "sandbox", "v25"]);

    expect(svc.get("bc25us")).toEqual({ tags: ["client1", "sandbox", "v25"] });
  });

  it("stores note and tags independently on the same container", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setNote("bc25us", "main dev");
    await svc.setTags("bc25us", ["dev"]);

    expect(svc.get("bc25us")).toEqual({ note: "main dev", tags: ["dev"] });
  });

  it("clears note but preserves tags when empty note is set", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setNote("bc25us", "initial note");
    await svc.setTags("bc25us", ["dev"]);
    await svc.setNote("bc25us", "");

    const ann = svc.get("bc25us");
    expect(ann?.note).toBeUndefined();
    expect(ann?.tags).toEqual(["dev"]);
  });

  it("clears tags but preserves note when empty tags array is set", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setNote("bc25us", "keep this note");
    await svc.setTags("bc25us", ["old-tag"]);
    await svc.setTags("bc25us", []);

    const ann = svc.get("bc25us");
    expect(ann?.note).toBe("keep this note");
    expect(ann?.tags).toBeUndefined();
  });

  it("removes the container entry entirely when both note and tags are cleared", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setNote("bc25us", "temp");
    await svc.setNote("bc25us", "");

    expect(svc.get("bc25us")).toBeUndefined();
  });

  it("clear() removes all annotations for a container", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setNote("bc25us", "some note");
    await svc.setTags("bc25us", ["tag1"]);
    await svc.clear("bc25us");

    expect(svc.get("bc25us")).toBeUndefined();
  });

  it("clear() does not affect annotations on other containers", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setNote("bc25us", "us container");
    await svc.setNote("bc25au", "au container");
    await svc.clear("bc25us");

    expect(svc.get("bc25us")).toBeUndefined();
    expect(svc.get("bc25au")).toEqual({ note: "au container" });
  });

  it("trims whitespace from tags", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setTags("bc25us", ["  client1  ", " sandbox", "v25 "]);

    expect(svc.get("bc25us")?.tags).toEqual(["client1", "sandbox", "v25"]);
  });

  it("filters out empty strings from tags", async () => {
    const memento = makeMementoStub();
    const svc = new ContainerAnnotationService(memento as any);

    await svc.setTags("bc25us", ["valid", "", "  "]);

    expect(svc.get("bc25us")?.tags).toEqual(["valid"]);
  });

  it("persists data across service instances sharing the same memento", async () => {
    const memento = makeMementoStub();
    const svc1 = new ContainerAnnotationService(memento as any);
    await svc1.setNote("bc25us", "shared note");

    const svc2 = new ContainerAnnotationService(memento as any);
    expect(svc2.get("bc25us")).toEqual({ note: "shared note" });
  });
});
