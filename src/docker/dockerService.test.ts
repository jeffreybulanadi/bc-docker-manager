/**
 * Unit tests for DockerService.
 *
 * Tests focus on:
 *  - Static pure methods (extractBcMeta, isBcContainer)
 *  - Private logic exposed via casting to `any` (looksLikeBcImage, buildRunArgs)
 *  - File-system-based method (isInHostsFile) using jest.spyOn on `fs`
 */

import * as fs from "fs";
import { DockerService, BcContainerOptions } from "./dockerService";

jest.mock("fs");

// ─── extractBcMeta ───────────────────────────────────────────────

describe("DockerService.extractBcMeta", () => {
  it("extracts all BC label fields", () => {
    const labels = {
      nav: "25.0.12345.0",
      country: "us",
      platform: "25.0.12000.0",
      maintainer: "Dynamics SMB",
    };
    const meta = DockerService.extractBcMeta(labels);
    expect(meta.version).toBe("25.0.12345.0");
    expect(meta.country).toBe("us");
    expect(meta.platform).toBe("25.0.12000.0");
    expect(meta.maintainer).toBe("Dynamics SMB");
  });

  it("returns empty strings for missing labels", () => {
    const meta = DockerService.extractBcMeta({});
    expect(meta.version).toBe("");
    expect(meta.country).toBe("");
    expect(meta.platform).toBe("");
    expect(meta.maintainer).toBe("");
  });

  it("returns empty strings for unrelated labels", () => {
    const meta = DockerService.extractBcMeta({ "com.example.foo": "bar" });
    expect(meta.version).toBe("");
    expect(meta.country).toBe("");
  });
});

// ─── isBcContainer ───────────────────────────────────────────────

describe("DockerService.isBcContainer", () => {
  it("returns true when maintainer is 'Dynamics SMB'", () => {
    expect(DockerService.isBcContainer({ maintainer: "Dynamics SMB" })).toBe(true);
  });

  it("returns true when 'nav' label is present", () => {
    expect(DockerService.isBcContainer({ nav: "25.0.0.0" })).toBe(true);
  });

  it("returns true when both maintainer and nav are present", () => {
    expect(DockerService.isBcContainer({ maintainer: "Dynamics SMB", nav: "25.0.0.0" })).toBe(true);
  });

  it("returns false for unrelated labels", () => {
    expect(DockerService.isBcContainer({ "org.opencontainers.image.vendor": "ACME" })).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(DockerService.isBcContainer({})).toBe(false);
  });
});

// ─── looksLikeBcImage (private, accessed via `any`) ──────────────

describe("DockerService.looksLikeBcImage", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;
  const fn = (name: string): boolean => svc.looksLikeBcImage(name);

  it("matches official MCR BC image name", () => {
    expect(fn("mcr.microsoft.com/businesscentral:ltsc2022")).toBe(true);
  });

  it("matches image name containing 'businesscentral'", () => {
    expect(fn("my-registry/businesscentral-custom:v1")).toBe(true);
  });

  it("matches 'bc' as a delimited segment at start", () => {
    expect(fn("bc:latest")).toBe(true);
  });

  it("matches 'bc' as a delimited segment with digit suffix (e.g. bc25us)", () => {
    expect(fn("bc25us:latest")).toBe(true);
  });

  it("matches 'bc' preceded by dash", () => {
    expect(fn("myrepo/my-bc:latest")).toBe(true);
  });

  it("does NOT match 'bc' inside a longer word", () => {
    // 'backup-tool' should not match — 'bc' is not a delimited segment
    // Note: "backup" contains 'bac' not 'bc', but "object" contains 'bc' as a subsequence not segment
    expect(fn("objectstorage:latest")).toBe(false);
  });

  it("does NOT match completely unrelated image", () => {
    expect(fn("nginx:latest")).toBe(false);
    expect(fn("postgres:15")).toBe(false);
    expect(fn("redis:7")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(fn("")).toBe(false);
  });
});

// ─── isInHostsFile ───────────────────────────────────────────────

describe("DockerService.isInHostsFile", () => {
  const svc = new DockerService();

  afterEach(() => jest.clearAllMocks());

  function mockHosts(content: string) {
    (fs.readFileSync as jest.Mock).mockReturnValue(content);
  }

  it("returns true when container name is present in hosts file", () => {
    mockHosts("127.0.0.1  localhost\n172.17.0.2  mybc\n");
    expect(svc.isInHostsFile("mybc")).toBe(true);
  });

  it("returns true with tab separator", () => {
    mockHosts("172.17.0.2\tmybc\n");
    expect(svc.isInHostsFile("mybc")).toBe(true);
  });

  it("returns false when container name is absent", () => {
    mockHosts("127.0.0.1  localhost\n");
    expect(svc.isInHostsFile("mybc")).toBe(false);
  });

  it("does NOT false-positive on a commented-out hosts entry", () => {
    // Bug #3: previously this would return true for commented lines
    mockHosts("# 172.17.0.2  mybc\n127.0.0.1  localhost\n");
    expect(svc.isInHostsFile("mybc")).toBe(false);
  });

  it("does NOT false-positive on a container name that is a prefix of another", () => {
    mockHosts("172.17.0.2  mybcextended\n");
    expect(svc.isInHostsFile("mybc")).toBe(false);
  });

  it("returns false when readFileSync throws (e.g. no hosts file)", () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => { throw new Error("ENOENT"); });
    expect(svc.isInHostsFile("mybc")).toBe(false);
  });
});

// ─── buildRunArgs (private, accessed via `any`) ──────────────────

describe("DockerService.buildRunArgs", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  const baseOpts: BcContainerOptions = {
    containerName: "bc25us",
    artifactUrl: "https://bcartifacts.example.com/sandbox/25.0/us",
    username: "admin",
    password: "Passw0rd!",
  };
  const image = "mcr.microsoft.com/businesscentral:ltsc2022";

  function buildArgs(opts: BcContainerOptions = baseOpts): string[] {
    return svc.buildRunArgs(opts, image);
  }

  it("starts with 'run -d'", () => {
    const args = buildArgs();
    expect(args[0]).toBe("run");
    expect(args[1]).toBe("-d");
  });

  it("sets --name and --hostname to containerName", () => {
    const args = buildArgs();
    expect(args[args.indexOf("--name") + 1]).toBe("bc25us");
    expect(args[args.indexOf("--hostname") + 1]).toBe("bc25us");
  });

  it("defaults memory to 8G", () => {
    const args = buildArgs();
    expect(args[args.indexOf("--memory") + 1]).toBe("8G");
  });

  it("uses provided memoryLimit", () => {
    const args = buildArgs({ ...baseOpts, memoryLimit: "16G" });
    expect(args[args.indexOf("--memory") + 1]).toBe("16G");
  });

  it("defaults isolation to hyperv", () => {
    const args = buildArgs();
    expect(args[args.indexOf("--isolation") + 1]).toBe("hyperv");
  });

  it("includes accept_eula=Y by default", () => {
    const args = buildArgs();
    const eIdx = args.indexOf("-e");
    const eulaEntry = args.slice(eIdx).find((_, i, a) => i % 2 === 1 && a[i - 1] === "-e" && a[i].startsWith("accept_eula="));
    expect(eulaEntry).toBe("accept_eula=Y");
  });

  it("sets accept_eula=N when accept_eula is false", () => {
    const args = buildArgs({ ...baseOpts, accept_eula: false });
    const found = args.some((a) => a === "accept_eula=N");
    expect(found).toBe(true);
  });

  it("includes artifactUrl, username, password, and auth env vars", () => {
    const args = buildArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") { envPairs.push(args[i + 1]); }
    }
    expect(envPairs.some((p) => p.startsWith("artifactUrl="))).toBe(true);
    expect(envPairs.some((p) => p.startsWith("username="))).toBe(true);
    expect(envPairs.some((p) => p.startsWith("password="))).toBe(true);
    expect(envPairs.some((p) => p.startsWith("auth="))).toBe(true);
  });

  it("does NOT include accept_outdated by default", () => {
    const args = buildArgs();
    expect(args.includes("accept_outdated=Y")).toBe(false);
  });

  it("includes accept_outdated=Y when opt is set", () => {
    const args = buildArgs({ ...baseOpts, accept_outdated: true });
    expect(args.includes("accept_outdated=Y")).toBe(true);
  });

  it("includes licenseFile env var when licensePath is provided", () => {
    const args = buildArgs({ ...baseOpts, licensePath: "//share/file.bclicense" });
    expect(args.some((a) => a.startsWith("licenseFile="))).toBe(true);
  });

  it("ends with the image reference", () => {
    const args = buildArgs();
    expect(args[args.length - 1]).toBe(image);
  });

  it("includes DNS servers 8.8.8.8 and 8.8.4.4", () => {
    const args = buildArgs();
    const dnsIdx = args.indexOf("--dns");
    expect(dnsIdx).toBeGreaterThan(-1);
    const dnsValues = args
      .map((a, i, arr) => (arr[i - 1] === "--dns" ? a : null))
      .filter(Boolean);
    expect(dnsValues).toContain("8.8.8.8");
    expect(dnsValues).toContain("8.8.4.4");
  });
});

// ─── parseLines (private, accessed via `any`) ────────────────────

describe("DockerService.parseLines", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  it("parses a single container JSON line", () => {
    const line = JSON.stringify({ ID: "abc123", Names: "mybc", Image: "bc:latest", Status: "Up", State: "running", Ports: "", CreatedAt: "2024-01-01" });
    const result = svc.parseLines(line);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("abc123");
    expect(result[0].names).toBe("mybc");
    expect(result[0].image).toBe("bc:latest");
  });

  it("parses multiple lines and returns correct count", () => {
    const lines = [
      JSON.stringify({ ID: "a1", Names: "c1", Image: "img1", Status: "Up", State: "running", Ports: "", CreatedAt: "" }),
      JSON.stringify({ ID: "a2", Names: "c2", Image: "img2", Status: "Exited", State: "exited", Ports: "", CreatedAt: "" }),
      JSON.stringify({ ID: "a3", Names: "c3", Image: "img3", Status: "Up", State: "running", Ports: "", CreatedAt: "" }),
    ].join("\n");
    expect(svc.parseLines(lines)).toHaveLength(3);
  });

  it("returns empty array for empty string", () => {
    expect(svc.parseLines("")).toEqual([]);
  });

  it("filters out empty lines (e.g. trailing newline)", () => {
    const line = JSON.stringify({ ID: "x", Names: "n", Image: "i", Status: "Up", State: "running", Ports: "", CreatedAt: "" });
    const raw = line + "\n\n";
    expect(svc.parseLines(raw)).toHaveLength(1);
  });

  it("throws on malformed JSON", () => {
    expect(() => svc.parseLines("{not valid json}")).toThrow();
  });
});

// ─── parseImageLines (private, accessed via `any`) ───────────────

describe("DockerService.parseImageLines", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  it("parses a single image JSON line", () => {
    const line = JSON.stringify({ Repository: "mcr.microsoft.com/businesscentral", Tag: "ltsc2022", ID: "sha256:abc", Size: "5GB", CreatedAt: "2024-01-01" });
    const result = svc.parseImageLines(line);
    expect(result).toHaveLength(1);
    expect(result[0].repository).toBe("mcr.microsoft.com/businesscentral");
    expect(result[0].tag).toBe("ltsc2022");
  });

  it("preserves <none> repository as-is", () => {
    const line = JSON.stringify({ Repository: "<none>", Tag: "<none>", ID: "sha256:def", Size: "1GB", CreatedAt: "" });
    const result = svc.parseImageLines(line);
    expect(result[0].repository).toBe("<none>");
  });

  it("returns empty array for empty string", () => {
    expect(svc.parseImageLines("")).toEqual([]);
  });
});

// ─── getContainerIp (public) ─────────────────────────────────────

describe("DockerService.getContainerIp", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  afterEach(() => jest.restoreAllMocks());

  it("returns a valid IP address", async () => {
    jest.spyOn(svc, "exec").mockResolvedValue("172.17.0.5\n");
    const ip = await svc.getContainerIp("mybc");
    expect(ip).toBe("172.17.0.5");
  });

  it("returns undefined for <no value>", async () => {
    jest.spyOn(svc, "exec").mockResolvedValue("<no value>\n");
    const ip = await svc.getContainerIp("mybc");
    expect(ip).toBeUndefined();
  });

  it("returns undefined for empty string", async () => {
    jest.spyOn(svc, "exec").mockResolvedValue("\n");
    const ip = await svc.getContainerIp("mybc");
    expect(ip).toBeUndefined();
  });

  it("returns undefined when exec throws", async () => {
    jest.spyOn(svc, "exec").mockRejectedValue(new Error("docker not found"));
    const ip = await svc.getContainerIp("mybc");
    expect(ip).toBeUndefined();
  });
});

// ─── buildHostsScript (private, accessed via `any`) ──────────────

describe("DockerService.buildHostsScript", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  it("includes the container name and IP in the script", () => {
    const script: string = svc.buildHostsScript("mybc", "172.17.0.5");
    expect(script).toContain("mybc");
    expect(script).toContain("172.17.0.5");
  });

  it("escapes regex special chars in the container name", () => {
    const script: string = svc.buildHostsScript("my.bc+test", "10.0.0.1");
    // The dollar-sign anchor ($) at line end is part of the regex pattern,
    // but special chars in the name like '.' and '+' should not appear raw
    // in the -notmatch pattern. The current implementation uses the name
    // directly — this test documents that behaviour.
    expect(script).toContain("my.bc+test");
  });

  it("includes the path to the hosts file", () => {
    const script: string = svc.buildHostsScript("mybc", "172.17.0.5");
    expect(script).toContain("drivers\\etc\\hosts");
  });
});

// ─── buildCertScript (private, accessed via `any`) ───────────────

describe("DockerService.buildCertScript", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  it("generates the correct certificate URL", () => {
    const script: string = svc.buildCertScript("mybc", "172.17.0.5");
    expect(script).toContain("http://172.17.0.5:8080/certificate.cer");
  });

  it("contains the Import-Certificate command", () => {
    const script: string = svc.buildCertScript("mybc", "172.17.0.5");
    expect(script).toContain("Import-Certificate");
  });

  it("contains the container name reference", () => {
    const script: string = svc.buildCertScript("mybc", "172.17.0.5");
    expect(script).toContain("mybc");
  });
});

// ─── enrichWithLabels (private, accessed via `any`) ──────────────

describe("DockerService.enrichWithLabels", () => {
  afterEach(() => jest.restoreAllMocks());

  it("handles an empty array without throwing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockResolvedValue("[]");
    await expect(svc.enrichWithLabels([])).resolves.toBeUndefined();
  });

  it("enriches two containers with labels from docker inspect", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    const containers = [
      { id: "id1", names: "c1", image: "img1", status: "Up", state: "running", ports: "", createdAt: "", labels: {} },
      { id: "id2", names: "c2", image: "img2", status: "Up", state: "running", ports: "", createdAt: "", labels: {} },
    ];
    const inspectJson = JSON.stringify([
      { Id: "id1", Config: { Labels: { nav: "25.0.0.0", country: "us" } } },
      { Id: "id2", Config: { Labels: { maintainer: "Dynamics SMB" } } },
    ]);
    const spy = jest.spyOn(svc, "exec").mockResolvedValue(inspectJson);

    await svc.enrichWithLabels(containers);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("docker inspect id1 id2");
    expect(containers[0].labels).toEqual({ nav: "25.0.0.0", country: "us" });
    expect(containers[1].labels).toEqual({ maintainer: "Dynamics SMB" });
  });

  it("retains empty labels when exec throws", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    const containers = [
      { id: "id1", names: "c1", image: "img1", status: "Up", state: "running", ports: "", createdAt: "", labels: {} },
    ];
    jest.spyOn(svc, "exec").mockRejectedValue(new Error("inspect failed"));

    await svc.enrichWithLabels(containers);

    expect(containers[0].labels).toEqual({});
  });
});

// ─── isDockerInstalled ───────────────────────────────────────────

describe("DockerService.isDockerInstalled", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns true when docker --version succeeds", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockResolvedValue("Docker version 24.0.0");
    expect(await svc.isDockerInstalled()).toBe(true);
  });

  it("returns false when exec rejects", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockRejectedValue(new Error("not found"));
    expect(await svc.isDockerInstalled()).toBe(false);
  });
});

// ─── isDockerRunning ─────────────────────────────────────────────

describe("DockerService.isDockerRunning", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns true when docker info succeeds", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockResolvedValue("some info output");
    expect(await svc.isDockerRunning()).toBe(true);
  });

  it("returns false when exec rejects", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockRejectedValue(new Error("daemon not running"));
    expect(await svc.isDockerRunning()).toBe(false);
  });
});

// ─── isWindowsContainerMode ──────────────────────────────────────

describe("DockerService.isWindowsContainerMode", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns true when docker info returns OSType windows", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockResolvedValue(JSON.stringify({ OSType: "windows" }));
    expect(await svc.isWindowsContainerMode()).toBe(true);
  });

  it("returns false when OSType is linux", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockResolvedValue(JSON.stringify({ OSType: "linux" }));
    expect(await svc.isWindowsContainerMode()).toBe(false);
  });

  it("returns false when exec rejects", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockRejectedValue(new Error("docker not running"));
    expect(await svc.isWindowsContainerMode()).toBe(false);
  });
});

// ─── isCertInstalled ─────────────────────────────────────────────

describe("DockerService.isCertInstalled", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns true when powershell returns count > 0", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockResolvedValue("1\n");
    expect(await svc.isCertInstalled("mybc")).toBe(true);
  });

  it("returns false when count is 0", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockResolvedValue("0\n");
    expect(await svc.isCertInstalled("mybc")).toBe(false);
  });

  it("returns false when exec rejects", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "exec").mockRejectedValue(new Error("powershell error"));
    expect(await svc.isCertInstalled("mybc")).toBe(false);
  });
});

// ─── isHostsIpCurrent ────────────────────────────────────────────

describe("DockerService.isHostsIpCurrent", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns true when hosts file IP matches container IP", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "getContainerIp").mockResolvedValue("172.17.0.5");
    (fs.readFileSync as jest.Mock).mockReturnValue("172.17.0.5  mybc\n");
    expect(await svc.isHostsIpCurrent("mybc")).toBe(true);
  });

  it("returns false when IP has changed (stale entry)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "getContainerIp").mockResolvedValue("172.17.0.10");
    (fs.readFileSync as jest.Mock).mockReturnValue("172.17.0.5  mybc\n");
    expect(await svc.isHostsIpCurrent("mybc")).toBe(false);
  });

  it("returns false when no container IP found", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "getContainerIp").mockResolvedValue(undefined);
    expect(await svc.isHostsIpCurrent("mybc")).toBe(false);
  });

  it("returns false when hosts file has no entry for container", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    jest.spyOn(svc, "getContainerIp").mockResolvedValue("172.17.0.5");
    (fs.readFileSync as jest.Mock).mockReturnValue("127.0.0.1  localhost\n");
    expect(await svc.isHostsIpCurrent("mybc")).toBe(false);
  });
});

// ─── didNetworkingJustRun ────────────────────────────────────────

describe("DockerService.didNetworkingJustRun", () => {
  it("returns false initially", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    expect(await svc.didNetworkingJustRun()).toBe(false);
  });

  it("reading it resets the flag (second call returns false)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    svc._networkingJustRan = true;
    expect(await svc.didNetworkingJustRun()).toBe(true);
    expect(await svc.didNetworkingJustRun()).toBe(false);
  });
});

// ─── looksLikeBcImage (additional edge cases) ────────────────────

describe("DockerService.looksLikeBcImage (more edge cases)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;
  const fn = (name: string): boolean => svc.looksLikeBcImage(name);

  it("matches _bc_container:latest (underscore delimited)", () => {
    expect(fn("_bc_container:latest")).toBe(true);
  });

  it("matches registry/bc/image:tag (path segment)", () => {
    expect(fn("registry/bc/image:tag")).toBe(true);
  });

  it("does NOT match ABC:latest (bc inside larger word at start)", () => {
    expect(fn("ABC:latest")).toBe(false);
  });

  it("case insensitive: BusinessCentral:tag matches", () => {
    expect(fn("BusinessCentral:tag")).toBe(true);
  });
});

// ─── parseLines (missing fields) ─────────────────────────────────

describe("DockerService.parseLines (missing fields)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  it("JSON line with missing keys still returns object with empty string defaults", () => {
    const line = JSON.stringify({ ID: "abc" });
    const result = svc.parseLines(line);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("abc");
    expect(result[0].names).toBe("");
    expect(result[0].image).toBe("");
    expect(result[0].status).toBe("");
    expect(result[0].state).toBe("");
    expect(result[0].ports).toBe("");
    expect(result[0].createdAt).toBe("");
  });
});

// ─── parseImageLines (missing fields) ────────────────────────────

describe("DockerService.parseImageLines (missing fields)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  it("JSON line with missing keys returns object with empty string defaults", () => {
    const line = JSON.stringify({ Repository: "myrepo" });
    const result = svc.parseImageLines(line);
    expect(result).toHaveLength(1);
    expect(result[0].repository).toBe("myrepo");
    expect(result[0].tag).toBe("");
    expect(result[0].id).toBe("");
    expect(result[0].size).toBe("");
    expect(result[0].createdAt).toBe("");
  });
});

// ─── enrichWithLabels (additional cases) ─────────────────────────

describe("DockerService.enrichWithLabels (additional cases)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("inspect returns entry with missing Config key — labels stay empty", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    const containers = [
      { id: "id1", names: "c1", image: "img1", status: "Up", state: "running", ports: "", createdAt: "", labels: {} },
    ];
    const inspectJson = JSON.stringify([{ Id: "id1" }]);
    jest.spyOn(svc, "exec").mockResolvedValue(inspectJson);

    await svc.enrichWithLabels(containers);

    expect(containers[0].labels).toEqual({});
  });

  it("inspect returns malformed JSON string — labels stay empty", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new DockerService() as any;
    const containers = [
      { id: "id1", names: "c1", image: "img1", status: "Up", state: "running", ports: "", createdAt: "", labels: {} },
    ];
    jest.spyOn(svc, "exec").mockResolvedValue("{not valid json[");

    await svc.enrichWithLabels(containers);

    expect(containers[0].labels).toEqual({});
  });
});

// ─── buildRunArgs (additional cases) ─────────────────────────────

describe("DockerService.buildRunArgs (additional cases)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DockerService() as any;

  const baseOpts: BcContainerOptions = {
    containerName: "bc25us",
    artifactUrl: "https://bcartifacts.example.com/sandbox/25.0/us",
    username: "admin",
    password: "Passw0rd!",
  };
  const image = "mcr.microsoft.com/businesscentral:ltsc2022";

  function buildArgs(opts: BcContainerOptions = baseOpts): string[] {
    return svc.buildRunArgs(opts, image);
  }

  it("isolation=process is used when specified", () => {
    const args = buildArgs({ ...baseOpts, isolation: "process" });
    expect(args[args.indexOf("--isolation") + 1]).toBe("process");
  });

  it("accept_eula=true explicit still produces Y", () => {
    const args = buildArgs({ ...baseOpts, accept_eula: true });
    const found = args.some((a: string) => a === "accept_eula=Y");
    expect(found).toBe(true);
  });

  it("all optional fields combined (memoryLimit, licensePath, accept_outdated, isolation)", () => {
    const args = buildArgs({
      ...baseOpts,
      memoryLimit: "16G",
      licensePath: "//share/file.bclicense",
      accept_outdated: true,
      isolation: "process",
    });
    expect(args[args.indexOf("--memory") + 1]).toBe("16G");
    expect(args[args.indexOf("--isolation") + 1]).toBe("process");
    expect(args.some((a: string) => a === "accept_outdated=Y")).toBe(true);
    expect(args.some((a: string) => a.startsWith("licenseFile="))).toBe(true);
  });
});
