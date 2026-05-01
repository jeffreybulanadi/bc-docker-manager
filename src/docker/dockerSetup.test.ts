/**
 * Unit tests for DockerSetup.
 *
 * Tests focus on the static detection helpers:
 *  - isOnPath, isDockerDesktopInstalled, findDockerExe, isDaemonRunning
 *  - installDockerEngine (short-circuit when daemon is already running)
 */

import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { DockerSetup } from "./dockerSetup";

jest.mock("child_process");
jest.mock("fs");
jest.mock("os");

const mockExec = exec as unknown as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockTmpdir = os.tmpdir as jest.Mock;

afterEach(() => jest.clearAllMocks());

// ─── isOnPath ────────────────────────────────────────────────────

describe("DockerSetup.isOnPath", () => {
  it("returns true when `docker --version` succeeds", async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, "Docker version 27.5.1\n", "");
    });
    await expect(DockerSetup.isOnPath()).resolves.toBe(true);
  });

  it("returns false when exec errors", async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(new Error("not found"), "", "");
    });
    await expect(DockerSetup.isOnPath()).resolves.toBe(false);
  });
});

// ─── isDockerDesktopInstalled ────────────────────────────────────

describe("DockerSetup.isDockerDesktopInstalled", () => {
  it("returns true when Docker Desktop path exists", async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p.includes("Docker Desktop") || p.includes("DockerDesktop"),
    );
    await expect(DockerSetup.isDockerDesktopInstalled()).resolves.toBe(true);
  });

  it("returns false when no Docker Desktop paths exist", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(DockerSetup.isDockerDesktopInstalled()).resolves.toBe(false);
  });
});

// ─── findDockerExe ───────────────────────────────────────────────

describe("DockerSetup.findDockerExe", () => {
  it('returns "docker" when isOnPath() returns true', async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, "Docker version 27.5.1\n", "");
    });
    await expect(DockerSetup.findDockerExe()).resolves.toBe("docker");
  });

  it("returns full path when found at a search location", async () => {
    // docker --version fails (not on PATH)
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(new Error("not found"), "", "");
    });
    // existsSync returns true for the first DOCKER_SEARCH_PATHS entry
    const expectedPath = `${process.env["ProgramFiles"]}\\docker\\docker.exe`;
    mockExistsSync.mockImplementation((p: string) => p === expectedPath);
    await expect(DockerSetup.findDockerExe()).resolves.toBe(expectedPath);
  });

  it("returns undefined when not found anywhere", async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(new Error("not found"), "", "");
    });
    mockExistsSync.mockReturnValue(false);
    await expect(DockerSetup.findDockerExe()).resolves.toBeUndefined();
  });
});

// ─── isDaemonRunning ─────────────────────────────────────────────

describe("DockerSetup.isDaemonRunning", () => {
  it("returns true when `docker info` succeeds", async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, "Server Version: 27.5.1\n", "");
    });
    await expect(DockerSetup.isDaemonRunning()).resolves.toBe(true);
  });

  it("returns false when exec errors", async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(new Error("Cannot connect to the Docker daemon"), "", "");
    });
    await expect(DockerSetup.isDaemonRunning()).resolves.toBe(false);
  });

  it("uses custom dockerPath when provided", async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, "", "");
    });
    await DockerSetup.isDaemonRunning("C:\\docker\\docker.exe");
    expect(mockExec).toHaveBeenCalledWith(
      '"C:\\docker\\docker.exe" info',
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
  });
});

// ─── installDockerEngine ─────────────────────────────────────────

describe("DockerSetup.installDockerEngine", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode");

  beforeEach(() => {
    mockTmpdir.mockReturnValue("C:\\Temp");
  });

  it("returns true when daemon is already running and user does not reinstall", async () => {
    // isDaemonRunning → true (first exec call is `docker info`)
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, "", "");
    });
    // User clicks "Cancel" (showInformationMessage resolves to something other than "Reinstall / Update")
    vscode.window.showInformationMessage.mockResolvedValueOnce("Cancel");

    const result = await DockerSetup.installDockerEngine();
    expect(result).toBe(true);
  });

  it("returns false when daemon is not running and Docker Desktop blocks install", async () => {
    // isDaemonRunning → false
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(new Error("daemon not running"), "", "");
    });
    // isDockerDesktopInstalled → true
    mockExistsSync.mockReturnValue(true);
    // User clicks "Cancel" on the Docker Desktop warning
    vscode.window.showWarningMessage.mockResolvedValueOnce("Cancel");

    const result = await DockerSetup.installDockerEngine();
    expect(result).toBe(false);
  });
});

// ─── isDaemonRunning - default path ─────────────────────────────

describe("isDaemonRunning - default path", () => {
  it('uses "docker" (default) when no path provided', async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, "", "");
    });
    await DockerSetup.isDaemonRunning();
    expect(mockExec).toHaveBeenCalledWith(
      '"docker" info',
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
  });
});

// ─── installDockerEngine - reinstall flow ───────────────────────

describe("installDockerEngine - reinstall flow", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode");

  beforeEach(() => {
    mockTmpdir.mockReturnValue("C:\\Temp");
    (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
    (fs.readFileSync as jest.Mock).mockReturnValue("SUCCESS");
    (fs.unlinkSync as jest.Mock).mockImplementation(() => {});
  });

  it("reinstalls when user clicks 'Reinstall / Update' and returns true", async () => {
    // All exec calls succeed (isDaemonRunning + wrapper script)
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(null, "", "");
    });
    // Docker Desktop NOT installed
    mockExistsSync.mockReturnValue(false);
    // User clicks "Reinstall / Update"
    vscode.window.showInformationMessage.mockResolvedValueOnce("Reinstall / Update");

    const result = await DockerSetup.installDockerEngine();
    expect(result).toBe(true);
  }, 15_000);
});

// ─── installDockerEngine - Docker Desktop present, Install Anyway ─

describe("installDockerEngine - Docker Desktop present, Install Anyway", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode");

  beforeEach(() => {
    mockTmpdir.mockReturnValue("C:\\Temp");
    (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
    (fs.readFileSync as jest.Mock).mockReturnValue("SUCCESS");
    (fs.unlinkSync as jest.Mock).mockImplementation(() => {});
  });

  it("installs when user clicks 'Install Anyway' and returns true", async () => {
    let infoCallCount = 0;
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      if (cmd.includes("info")) {
        infoCallCount++;
        if (infoCallCount === 1) {
          // isDaemonRunning - first check: daemon NOT running
          cb(new Error("not running"), "", "");
        } else {
          // isDaemonRunning - after install: daemon running
          cb(null, "", "");
        }
      } else {
        // wrapper script exec succeeds
        cb(null, "", "");
      }
    });
    // Docker Desktop IS installed
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === "string" &&
      (p.includes("Docker Desktop") || p.includes("DockerDesktop")),
    );
    // User clicks "Install Anyway"
    vscode.window.showWarningMessage.mockResolvedValueOnce("Install Anyway");

    const result = await DockerSetup.installDockerEngine();
    expect(result).toBe(true);
  }, 15_000);
});

// ─── installDockerEngine - Docker Desktop present, user cancels ──

describe("installDockerEngine - Docker Desktop present, user cancels", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode");

  it("returns false when user cancels the Docker Desktop warning", async () => {
    // isDaemonRunning → false
    mockExec.mockImplementation((cmd: string, opts: unknown, cb: Function) => {
      cb(new Error("not running"), "", "");
    });
    // Docker Desktop IS installed
    mockExistsSync.mockReturnValue(true);
    // User clicks "Cancel"
    vscode.window.showWarningMessage.mockResolvedValueOnce("Cancel");

    const result = await DockerSetup.installDockerEngine();
    expect(result).toBe(false);
  });
});
