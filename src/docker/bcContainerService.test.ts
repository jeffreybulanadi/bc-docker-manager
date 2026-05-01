/**
 * Unit tests for BcContainerService.
 *
 * Tests focus on:
 *  - Shell helpers (exec, execInContainer) via casting to `any`
 *  - File transfer helpers (writeFileToContainer, readFileFromContainer) via Base64 chunking
 *  - Cached metadata (getContainerInfo with TTL)
 *  - Copy Container IP
 *  - Volume parsing (getVolumes, removeVolume)
 *  - Profile I/O (load, save, delete)
 *  - Container stats
 *  - Export / Import
 */

import { exec } from "child_process";
import * as fs from "fs";
import * as vscode from "vscode";
import { BcContainerService } from "./bcContainerService";

jest.mock("child_process", () => ({
  exec: jest.fn(),
}));
jest.mock("fs");

const mockExec = exec as unknown as jest.Mock;
const mockFs = fs as jest.Mocked<typeof fs>;

/** Simulate a successful child_process.exec call. */
function fakeExecOk(stdout: string) {
  mockExec.mockImplementationOnce((_cmd: string, _opts: any, cb: Function) => {
    cb(null, stdout, "");
  });
}

/** Simulate a failed child_process.exec call. */
function fakeExecFail(stderr: string) {
  mockExec.mockImplementationOnce((_cmd: string, _opts: any, cb: Function) => {
    cb(new Error("exec error"), "", stderr);
  });
}

/** Create a minimal mock of DockerService. */
function createMockDocker(): any {
  return {
    getContainerIp: jest.fn(),
  };
}

let docker: ReturnType<typeof createMockDocker>;
let svc: BcContainerService;

beforeEach(() => {
  jest.clearAllMocks();
  docker = createMockDocker();
  svc = new BcContainerService(docker);
});

// ─── cleanPsError (private static, accessed via any) ─────────────

describe("cleanPsError", () => {
  const clean = (raw: string) => (BcContainerService as any).cleanPsError(raw);

  it("returns empty string for empty input", () => {
    expect(clean("")).toBe("");
  });

  it("strips ANSI escape sequences", () => {
    expect(clean("\x1b[31;1mSome error\x1b[0m")).toBe("Some error");
  });

  it("extracts the value line from a structured PowerShell error", () => {
    const raw = [
      "\x1b[31;1mImport-NAVServerLicense : \x1b[0m",
      "Line |",
      "  15 |     $output = Import-NAVServerLicense @cmdletArgs;",
      "     |               ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
      "     | Your program license has expired.",
    ].join("\n");
    expect(clean(raw)).toBe("Import-NAVServerLicense: Your program license has expired.");
  });

  it("skips underline-only lines when extracting value", () => {
    const raw = "Set-NAVServerInstance : \n     |     ~~~~~~~~~~~\n     | Service not found.";
    expect(clean(raw)).toBe("Set-NAVServerInstance: Service not found.");
  });

  it("falls back to first non-empty line when no PS structure found", () => {
    expect(clean("container not found\nmore details")).toBe("container not found");
  });

  it("handles plain stderr with no ANSI and no PS structure", () => {
    expect(clean("permission denied")).toBe("permission denied");
  });
});

// ─── exec (private, accessed via `any`) ──────────────────────────

describe("exec", () => {
  it("resolves with stdout on success", async () => {
    fakeExecOk("hello world\n");
    const result = await (svc as any).exec("echo hello world");
    expect(result).toBe("hello world\n");
    expect(mockExec).toHaveBeenCalledWith(
      "echo hello world",
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    );
  });

  it("uses custom timeout when provided", async () => {
    fakeExecOk("ok");
    await (svc as any).exec("some-cmd", 5000);
    expect(mockExec).toHaveBeenCalledWith(
      "some-cmd",
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it("rejects with cleaned stderr message on error", async () => {
    fakeExecFail("permission denied");
    await expect((svc as any).exec("bad-cmd")).rejects.toThrow("permission denied");
  });

  it("strips ANSI codes from stderr when rejecting", async () => {
    fakeExecFail("\x1b[31;1mContainer not found\x1b[0m");
    await expect((svc as any).exec("bad-cmd")).rejects.toThrow("Container not found");
  });

  it("rejects with err.message when stderr is empty", async () => {
    mockExec.mockImplementationOnce((_cmd: string, _opts: any, cb: Function) => {
      cb(new Error("TIMEOUT"), "", "");
    });
    await expect((svc as any).exec("slow-cmd")).rejects.toThrow("TIMEOUT");
  });
});

// ─── execInContainer (private) ───────────────────────────────────

describe("execInContainer", () => {
  it("builds correct docker exec command", async () => {
    fakeExecOk("output");
    await (svc as any).execInContainer("mybc", "Get-Process");
    expect(mockExec).toHaveBeenCalledWith(
      'docker exec mybc powershell -NoProfile -Command "Get-Process"',
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    );
  });

  it("escapes double quotes in the PowerShell command", async () => {
    fakeExecOk("output");
    await (svc as any).execInContainer("mybc", 'Write-Host "hello"');
    const calledCmd = mockExec.mock.calls[0][0];
    expect(calledCmd).toContain('Write-Host \\"hello\\"');
  });

  it("forwards custom timeout", async () => {
    fakeExecOk("ok");
    await (svc as any).execInContainer("mybc", "Get-Process", 9999);
    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 9999 }),
      expect.any(Function),
    );
  });

  it("rejects when underlying exec fails", async () => {
    fakeExecFail("container not found");
    await expect(
      (svc as any).execInContainer("gone", "Get-Process"),
    ).rejects.toThrow("container not found");
  });
});

// ─── writeFileToContainer (private) ──────────────────────────────

describe("writeFileToContainer", () => {
  it("writes an empty file via WriteAllBytes with empty array", async () => {
    mockFs.readFileSync.mockReturnValueOnce(Buffer.alloc(0));
    fakeExecOk(""); // execInContainer for empty file
    await (svc as any).writeFileToContainer("mybc", "C:\\host\\empty.txt", "C:\\run\\my\\empty.txt");
    const cmd: string = mockExec.mock.calls[0][0];
    expect(cmd).toContain("WriteAllBytes");
    expect(cmd).toContain("@()");
  });

  it("writes a single-chunk file via WriteAllBytes", async () => {
    const data = Buffer.from("hello BC");
    mockFs.readFileSync.mockReturnValueOnce(data);
    fakeExecOk(""); // execInContainer for single chunk
    await (svc as any).writeFileToContainer("mybc", "C:\\host\\lic.flf", "C:\\run\\my\\lic.flf");
    const cmd: string = mockExec.mock.calls[0][0];
    expect(cmd).toContain("WriteAllBytes");
    expect(cmd).toContain(data.toString("base64"));
  });

  it("writes a multi-chunk file using WriteAllBytes then FileStream append", async () => {
    const data = Buffer.alloc(5_001, 0xAB); // 5001 bytes => 2 chunks
    mockFs.readFileSync.mockReturnValueOnce(data);
    fakeExecOk(""); // chunk 1
    fakeExecOk(""); // chunk 2
    await (svc as any).writeFileToContainer("mybc", "C:\\host\\big.bak", "C:\\run\\big.bak");
    expect(mockExec).toHaveBeenCalledTimes(2);
    const firstCmd: string = mockExec.mock.calls[0][0];
    const secondCmd: string = mockExec.mock.calls[1][0];
    expect(firstCmd).toContain("WriteAllBytes");
    expect(secondCmd).toContain("System.IO.File]::Open");
    expect(secondCmd).toContain("Append");
  });

  it("escapes single quotes in container path", async () => {
    const data = Buffer.from("x");
    mockFs.readFileSync.mockReturnValueOnce(data);
    fakeExecOk("");
    await (svc as any).writeFileToContainer("mybc", "C:\\host\\f.txt", "C:\\path with 'quotes'\\f.txt");
    const cmd: string = mockExec.mock.calls[0][0];
    expect(cmd).toContain("C:\\path with ''quotes''\\f.txt");
  });
});

// ─── readFileFromContainer (private) ─────────────────────────────

describe("readFileFromContainer", () => {
  it("reads a file in a single chunk and writes to host", async () => {
    const fileContent = Buffer.from("recovered data");
    const b64 = fileContent.toString("base64");
    fakeExecOk(`${fileContent.length}\n`); // Get-Item Length
    fakeExecOk(`${b64}\n`);                // single read chunk
    mockFs.writeFileSync.mockImplementation(() => {});
    await (svc as any).readFileFromContainer("mybc", "C:\\run\\out.bak", "D:\\local\\out.bak");
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "D:\\local\\out.bak",
      expect.any(Buffer),
    );
    const written: Buffer = (mockFs.writeFileSync as jest.Mock).mock.calls[0][1];
    expect(written.toString()).toBe("recovered data");
  });

  it("concatenates multiple chunks correctly", async () => {
    const chunk1 = Buffer.alloc(50_000, 0x01);
    const chunk2 = Buffer.alloc(100, 0x02);
    const fileSize = 50_100;
    fakeExecOk(`${fileSize}\n`);
    fakeExecOk(`${chunk1.toString("base64")}\n`);
    fakeExecOk(`${chunk2.toString("base64")}\n`);
    mockFs.writeFileSync.mockImplementation(() => {});
    await (svc as any).readFileFromContainer("mybc", "C:\\run\\big.bak", "D:\\big.bak");
    const written: Buffer = (mockFs.writeFileSync as jest.Mock).mock.calls[0][1];
    expect(written.length).toBe(50_100);
    expect(written[0]).toBe(0x01);
    expect(written[50_000]).toBe(0x02);
  });
});

// ─── getContainerInfo caching ────────────────────────────────────

describe("getContainerInfo", () => {
  const infoJson = JSON.stringify({
    ServerInstance: "NAV",
    DatabaseName: "MyDB",
  });

  it("fetches and returns parsed info on first call", async () => {
    fakeExecOk(infoJson);
    const result = await (svc as any).getContainerInfo("mybc");
    expect(result).toEqual({ serverInstance: "NAV", dbName: "MyDB" });
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on second call within TTL", async () => {
    fakeExecOk(infoJson);
    await (svc as any).getContainerInfo("mybc");
    const result = await (svc as any).getContainerInfo("mybc");
    expect(result).toEqual({ serverInstance: "NAV", dbName: "MyDB" });
    // exec should only be called once — second call uses cache
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    fakeExecOk(infoJson);
    await (svc as any).getContainerInfo("mybc");

    // Expire the cache entry by manipulating its timestamp
    const cache: Map<string, any> = (svc as any)._containerInfoCache;
    const entry = cache.get("mybc")!;
    entry.ts = Date.now() - 120_000; // 2 minutes ago

    const updatedJson = JSON.stringify({
      ServerInstance: "BC2",
      DatabaseName: "CronusNew",
    });
    fakeExecOk(updatedJson);
    const result = await (svc as any).getContainerInfo("mybc");
    expect(result).toEqual({ serverInstance: "BC2", dbName: "CronusNew" });
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("returns defaults on error", async () => {
    fakeExecFail("container not running");
    const result = await (svc as any).getContainerInfo("dead");
    expect(result).toEqual({ serverInstance: "BC", dbName: "CRONUS" });
  });

  it("returns defaults when JSON is invalid", async () => {
    fakeExecOk("not valid json");
    const result = await (svc as any).getContainerInfo("badjson");
    expect(result).toEqual({ serverInstance: "BC", dbName: "CRONUS" });
  });

  it("caches separate entries per container", async () => {
    fakeExecOk(JSON.stringify({ ServerInstance: "S1", DatabaseName: "D1" }));
    fakeExecOk(JSON.stringify({ ServerInstance: "S2", DatabaseName: "D2" }));
    const r1 = await (svc as any).getContainerInfo("c1");
    const r2 = await (svc as any).getContainerInfo("c2");
    expect(r1.serverInstance).toBe("S1");
    expect(r2.serverInstance).toBe("S2");
    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});

// ─── getServerInstance / getDatabaseName ─────────────────────────

describe("getServerInstance / getDatabaseName", () => {
  it("getServerInstance delegates to getContainerInfo", async () => {
    fakeExecOk(JSON.stringify({ ServerInstance: "NAV", DatabaseName: "DB1" }));
    const si = await (svc as any).getServerInstance("mybc");
    expect(si).toBe("NAV");
  });

  it("getDatabaseName delegates to getContainerInfo", async () => {
    fakeExecOk(JSON.stringify({ ServerInstance: "NAV", DatabaseName: "DB1" }));
    const db = await (svc as any).getDatabaseName("mybc");
    expect(db).toBe("DB1");
  });
});

// ─── copyContainerIp ─────────────────────────────────────────────

describe("copyContainerIp", () => {
  it("copies IP to clipboard and shows info message", async () => {
    docker.getContainerIp.mockResolvedValue("172.17.0.5");
    await svc.copyContainerIp("mybc");
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("172.17.0.5");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Container IP 172.17.0.5 copied to clipboard.",
    );
  });

  it("shows warning when no IP is returned (empty string)", async () => {
    docker.getContainerIp.mockResolvedValue("");
    await svc.copyContainerIp("mybc");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Could not determine IP"),
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("shows warning when IP is undefined", async () => {
    docker.getContainerIp.mockResolvedValue(undefined);
    await svc.copyContainerIp("mybc");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Could not determine IP"),
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });
});

// ─── getVolumes ──────────────────────────────────────────────────

describe("getVolumes", () => {
  it("parses multi-line JSON docker output", async () => {
    const line1 = JSON.stringify({ Driver: "local", Name: "vol1", Mountpoint: "/var/lib/docker/volumes/vol1/_data" });
    const line2 = JSON.stringify({ Driver: "local", Name: "vol2", Mountpoint: "/var/lib/docker/volumes/vol2/_data" });
    fakeExecOk(`${line1}\n${line2}\n`);

    const volumes = await svc.getVolumes();
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toEqual({
      driver: "local",
      name: "vol1",
      mountpoint: "/var/lib/docker/volumes/vol1/_data",
    });
    expect(volumes[1]).toEqual({
      driver: "local",
      name: "vol2",
      mountpoint: "/var/lib/docker/volumes/vol2/_data",
    });
  });

  it("handles empty output", async () => {
    fakeExecOk("");
    const volumes = await svc.getVolumes();
    expect(volumes).toEqual([]);
  });

  it("handles output with trailing newlines and blank lines", async () => {
    const line = JSON.stringify({ Driver: "local", Name: "v1", Mountpoint: "/data" });
    fakeExecOk(`\n${line}\n\n`);
    const volumes = await svc.getVolumes();
    expect(volumes).toHaveLength(1);
    expect(volumes[0].name).toBe("v1");
  });

  it("maps Driver, Name, Mountpoint to lowercase keys", async () => {
    fakeExecOk(JSON.stringify({ Driver: "overlay2", Name: "myVol", Mountpoint: "/mnt" }) + "\n");
    const [vol] = await svc.getVolumes();
    expect(vol.driver).toBe("overlay2");
    expect(vol.name).toBe("myVol");
    expect(vol.mountpoint).toBe("/mnt");
  });

  it("defaults mountpoint to empty string when missing", async () => {
    fakeExecOk(JSON.stringify({ Driver: "local", Name: "noMount" }) + "\n");
    const [vol] = await svc.getVolumes();
    expect(vol.mountpoint).toBe("");
  });

  it("runs the correct docker command", async () => {
    fakeExecOk("");
    await svc.getVolumes();
    expect(mockExec.mock.calls[0][0]).toBe(
      'docker volume ls --format "{{json .}}"',
    );
  });
});

// ─── removeVolume ────────────────────────────────────────────────

describe("removeVolume", () => {
  it("runs docker volume rm with the given name", async () => {
    fakeExecOk("");
    await svc.removeVolume("my-volume");
    expect(mockExec.mock.calls[0][0]).toBe("docker volume rm my-volume");
  });

  it("rejects when docker command fails", async () => {
    fakeExecFail("volume in use");
    await expect(svc.removeVolume("busy")).rejects.toThrow("volume in use");
  });
});

// ─── setProfileStoragePath ───────────────────────────────────────

describe("setProfileStoragePath", () => {
  it("stores the path used by profile file operations", () => {
    svc.setProfileStoragePath("C:\\Users\\test\\.bcmanager");
    expect((svc as any)._profileStoragePath).toBe("C:\\Users\\test\\.bcmanager");
  });
});

// ─── Profile I/O ─────────────────────────────────────────────────

describe("loadProfiles (private)", () => {
  beforeEach(() => {
    svc.setProfileStoragePath("C:\\profiles");
  });

  it("returns {} when file does not exist", () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    const result = (svc as any).loadProfiles();
    expect(result).toEqual({});
  });

  it("returns parsed JSON when file exists", () => {
    const profiles = {
      dev: {
        name: "dev",
        memoryLimit: "8G",
        isolation: "hyperv",
        auth: "UserPassword",
        dns: "8.8.8.8",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(profiles));
    const result = (svc as any).loadProfiles();
    expect(result).toEqual(profiles);
  });

  it("returns {} on corrupt JSON", () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue("{{{{not json");
    const result = (svc as any).loadProfiles();
    expect(result).toEqual({});
  });

  it("returns {} when readFileSync throws", () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error("EACCES");
    });
    const result = (svc as any).loadProfiles();
    expect(result).toEqual({});
  });
});

describe("saveProfiles (private)", () => {
  beforeEach(() => {
    svc.setProfileStoragePath("C:\\profiles");
  });

  it("creates directory if it does not exist", () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

    (svc as any).saveProfiles({ test: { name: "test" } });
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
  });

  it("does not create directory if it already exists", () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

    (svc as any).saveProfiles({});
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it("writes formatted JSON", () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

    const profiles = { dev: { name: "dev", memoryLimit: "4G" } };
    (svc as any).saveProfiles(profiles);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("container-profiles.json"),
      JSON.stringify(profiles, null, 2),
      "utf-8",
    );
  });
});

// ─── saveProfile (public, async) ─────────────────────────────────

describe("saveProfile", () => {
  beforeEach(() => {
    svc.setProfileStoragePath("C:\\profiles");
    // loadProfiles returns empty
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  });

  it("returns early when user cancels name input", async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);
    await svc.saveProfile();
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("prompts user and saves profile with config values", async () => {
    // Name prompt
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce("my-profile")   // profile name
      .mockResolvedValueOnce("")              // country (empty = skip)
      .mockResolvedValueOnce("");             // license (empty = skip)

    await svc.saveProfile();

    expect(mockFs.writeFileSync).toHaveBeenCalled();
    const written = JSON.parse((mockFs.writeFileSync as jest.Mock).mock.calls[0][1]);
    expect(written["my-profile"]).toBeDefined();
    expect(written["my-profile"].name).toBe("my-profile");
    expect(written["my-profile"].createdAt).toBeDefined();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Profile "my-profile" saved.',
    );
  });

  it("includes country and license when user provides them", async () => {
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce("full-profile")
      .mockResolvedValueOnce("us")
      .mockResolvedValueOnce("C:\\license.flf");

    await svc.saveProfile();

    const written = JSON.parse((mockFs.writeFileSync as jest.Mock).mock.calls[0][1]);
    expect(written["full-profile"].country).toBe("us");
    expect(written["full-profile"].licensePath).toBe("C:\\license.flf");
  });
});

// ─── loadProfile (public, async) ─────────────────────────────────

describe("loadProfile", () => {
  beforeEach(() => {
    svc.setProfileStoragePath("C:\\profiles");
  });

  it("shows info message and returns undefined when no profiles exist", async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    const result = await svc.loadProfile();
    expect(result).toBeUndefined();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("No saved profiles"),
    );
  });

  it("shows QuickPick and returns selected profile", async () => {
    const profiles = {
      dev: {
        name: "dev",
        memoryLimit: "8G",
        isolation: "hyperv",
        auth: "UserPassword",
        dns: "8.8.8.8",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(profiles));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
      label: "dev",
      description: "hyperv | 8G | UserPassword",
    });

    const result = await svc.loadProfile();
    expect(result).toEqual(profiles.dev);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Profile "dev" loaded.',
    );
  });

  it("returns undefined when user cancels QuickPick", async () => {
    const profiles = {
      dev: {
        name: "dev",
        memoryLimit: "8G",
        isolation: "hyperv",
        auth: "UserPassword",
        dns: "8.8.8.8",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(profiles));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);

    const result = await svc.loadProfile();
    expect(result).toBeUndefined();
  });
});

// ─── deleteProfile (public, async) ───────────────────────────────

describe("deleteProfile", () => {
  beforeEach(() => {
    svc.setProfileStoragePath("C:\\profiles");
  });

  it("shows info message when no profiles exist", async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    await svc.deleteProfile();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "No saved profiles.",
    );
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("removes selected profile and saves", async () => {
    const profiles = {
      dev: { name: "dev", memoryLimit: "8G", isolation: "hyperv", auth: "UserPassword", dns: "8.8.8.8", createdAt: "2024-01-01" },
      prod: { name: "prod", memoryLimit: "16G", isolation: "process", auth: "Windows", dns: "1.1.1.1", createdAt: "2024-02-01" },
    };
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(profiles));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ label: "dev" });
    (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

    await svc.deleteProfile();

    const written = JSON.parse((mockFs.writeFileSync as jest.Mock).mock.calls[0][1]);
    expect(written).not.toHaveProperty("dev");
    expect(written).toHaveProperty("prod");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Profile "dev" deleted.',
    );
  });

  it("returns early when user cancels QuickPick", async () => {
    const profiles = { dev: { name: "dev", memoryLimit: "8G", isolation: "hyperv", auth: "UserPassword", dns: "8.8.8.8", createdAt: "2024-01-01" } };
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(profiles));
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);

    await svc.deleteProfile();
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ─── backupDatabase edition detection ────────────────────────────

describe("backupDatabase edition detection", () => {
  beforeEach(() => {
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(
      vscode.Uri.file("C:\\backups\\mybc_backup.bak"),
    );
  });

  it("uses WITH FORMAT COMPRESSION on non-Express editions", async () => {
    fakeExecOk(JSON.stringify({ ServerInstance: "BC", DatabaseName: "MyDB" })); // getContainerInfo
    fakeExecOk("3\n"); // EngineEdition = 3 (Enterprise)
    fakeExecOk("");    // New-Item temp dir
    fakeExecOk("");    // BACKUP DATABASE
    // readFileFromContainer: size query + read chunk
    fakeExecOk("0\n");
    mockFs.writeFileSync.mockImplementation(() => {});
    fakeExecOk(""); // cleanup

    await svc.backupDatabase("mybc");

    const calls: string[] = mockExec.mock.calls.map((c: any[]) => c[0] as string);
    const backupCall = calls.find(c => c.includes("BACKUP DATABASE"));
    expect(backupCall).toBeDefined();
    expect(backupCall).toContain("WITH FORMAT, COMPRESSION");
  });

  it("uses WITH FORMAT only on SQL Server Express (EngineEdition 4)", async () => {
    fakeExecOk(JSON.stringify({ ServerInstance: "BC", DatabaseName: "MyDB" })); // getContainerInfo
    fakeExecOk("4\n"); // EngineEdition = 4 (Express)
    fakeExecOk("");    // New-Item temp dir
    fakeExecOk("");    // BACKUP DATABASE
    fakeExecOk("0\n");
    mockFs.writeFileSync.mockImplementation(() => {});
    fakeExecOk(""); // cleanup

    await svc.backupDatabase("mybc");

    const calls: string[] = mockExec.mock.calls.map((c: any[]) => c[0] as string);
    const backupCall = calls.find(c => c.includes("BACKUP DATABASE"));
    expect(backupCall).toBeDefined();
    expect(backupCall).not.toContain("COMPRESSION");
  });

  it("defaults to WITH FORMAT COMPRESSION when edition check fails", async () => {
    fakeExecOk(JSON.stringify({ ServerInstance: "BC", DatabaseName: "MyDB" })); // getContainerInfo
    fakeExecFail("cmdlet not found"); // edition check fails
    fakeExecOk("");    // New-Item temp dir
    fakeExecOk("");    // BACKUP DATABASE
    fakeExecOk("0\n");
    mockFs.writeFileSync.mockImplementation(() => {});
    fakeExecOk(""); // cleanup

    await svc.backupDatabase("mybc");

    const calls: string[] = mockExec.mock.calls.map((c: any[]) => c[0] as string);
    const backupCall = calls.find(c => c.includes("BACKUP DATABASE"));
    expect(backupCall).toBeDefined();
    expect(backupCall).toContain("WITH FORMAT, COMPRESSION");
  });
});

// ─── getContainerStats ───────────────────────────────────────────

describe("getContainerStats", () => {
  it("returns trimmed docker stats JSON output", async () => {
    const statsJson = '{"Container":"mybc","CPUPerc":"0.50%","MemUsage":"1GiB / 8GiB"}';
    fakeExecOk(`${statsJson}\n`);
    const result = await svc.getContainerStats("mybc");
    expect(result).toBe(statsJson);
  });

  it("runs the correct docker command with 10s timeout", async () => {
    fakeExecOk("{}");
    await svc.getContainerStats("mybc");
    expect(mockExec.mock.calls[0][0]).toBe(
      'docker stats mybc --no-stream --format "{{json .}}"',
    );
    expect(mockExec.mock.calls[0][1]).toEqual(
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("rejects when docker command fails", async () => {
    fakeExecFail("no such container");
    await expect(svc.getContainerStats("gone")).rejects.toThrow("no such container");
  });
});

// ─── exportContainer ─────────────────────────────────────────────

describe("exportContainer", () => {
  it("returns early when user cancels save dialog", async () => {
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);
    await svc.exportContainer("mybc");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("commits, saves, and cleans up image", async () => {
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce({
      fsPath: "C:\\exports\\mybc.tar",
    });

    // docker commit
    fakeExecOk("sha256:abc123");
    // docker save
    fakeExecOk("");
    // docker rmi (cleanup)
    fakeExecOk("");

    await svc.exportContainer("mybc");

    expect(mockExec.mock.calls[0][0]).toBe("docker commit mybc mybc-export:latest");
    expect(mockExec.mock.calls[1][0]).toBe('docker save -o "C:\\exports\\mybc.tar" mybc-export:latest');
    expect(mockExec.mock.calls[2][0]).toBe("docker rmi mybc-export:latest");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("exported"),
    );
  });

  it("still succeeds when rmi cleanup fails", async () => {
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce({
      fsPath: "C:\\out.tar",
    });

    // docker commit
    fakeExecOk("sha256:abc");
    // docker save
    fakeExecOk("");
    // docker rmi fails
    fakeExecFail("image in use");

    await svc.exportContainer("mybc");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("exported"),
    );
  });
});

// ─── importContainer ─────────────────────────────────────────────

describe("importContainer", () => {
  it("returns early when user cancels open dialog", async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce(undefined);
    await svc.importContainer();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns early when user selects no files", async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([]);
    await svc.importContainer();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("loads .tar and shows success message", async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([
      { fsPath: "C:\\imports\\mybc.tar" },
    ]);
    fakeExecOk("Loaded image: mybc-export:latest");

    await svc.importContainer();

    expect(mockExec.mock.calls[0][0]).toBe('docker load -i "C:\\imports\\mybc.tar"');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("imported"),
    );
  });
});
