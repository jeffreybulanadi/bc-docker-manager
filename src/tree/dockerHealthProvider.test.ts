/**
 * Unit tests for DockerHealthProvider.
 *
 * Covers private helpers (_getFeatureState, _isServiceInstalled,
 * _checkWindowsFeatures, _checkDockerEngine), the isAllHealthy getter,
 * and the static startDockerEngine method.
 */

import { exec } from "child_process";
import { DockerHealthProvider } from "./dockerHealthProvider";

jest.mock("child_process");
const mockExec = exec as unknown as jest.Mock;

// Prevent the constructor's auto-refresh timer from firing during tests.
beforeEach(() => {
  jest.useFakeTimers();
  // Default: exec succeeds with empty output so the constructor's _runChecks
  // doesn't throw unexpectedly.
  mockExec.mockImplementation(
    (_cmd: string, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      callback(null, "", "");
    },
  );
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

/** Helper: build a provider without the constructor's checks interfering. */
function createProvider(): DockerHealthProvider {
  return new DockerHealthProvider();
}

// ─── _getFeatureState ────────────────────────────────────────────

describe("_getFeatureState", () => {
  it("returns trimmed lowercase output for 'Enabled'", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(null, "  Enabled  \n", ""); },
    );

    const result = await (provider as any)._getFeatureState("Microsoft-Hyper-V");
    expect(result).toBe("enabled");
  });

  it("returns trimmed lowercase output for 'Disabled'", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(null, "  Disabled  \n", ""); },
    );

    const result = await (provider as any)._getFeatureState("Containers");
    expect(result).toBe("disabled");
  });

  it("rejects when exec returns an error", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(new Error("fail"), "", ""); },
    );

    await expect((provider as any)._getFeatureState("Containers")).rejects.toThrow("fail");
    provider.dispose();
  });
});

// ─── _isServiceInstalled ─────────────────────────────────────────

describe("_isServiceInstalled", () => {
  it("returns true when sc query succeeds", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(null, "SERVICE_NAME: vmms\n", ""); },
    );

    const result = await (provider as any)._isServiceInstalled("vmms");
    expect(result).toBe(true);
    provider.dispose();
  });

  it("returns false when sc query throws", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(new Error("1060"), "", ""); },
    );

    const result = await (provider as any)._isServiceInstalled("vmms");
    expect(result).toBe(false);
    provider.dispose();
  });
});

// ─── _checkWindowsFeatures ───────────────────────────────────────

describe("_checkWindowsFeatures", () => {
  it("returns ok when both Hyper-V and Containers are enabled", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(null, "Enabled\n", ""); },
    );

    const result = await (provider as any)._checkWindowsFeatures();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("Hyper-V & Containers enabled");
    provider.dispose();
  });

  it("returns error when Hyper-V enabled but Containers disabled", async () => {
    const provider = createProvider();
    let callIndex = 0;
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        callIndex++;
        if (cmd.includes("Microsoft-Hyper-V")) {
          cb(null, "Enabled\n", "");
        } else {
          cb(null, "Disabled\n", "");
        }
      },
    );

    const result = await (provider as any)._checkWindowsFeatures();
    expect(result.status).toBe("error");
    expect(result.detail).toContain("Containers");
    provider.dispose();
  });

  it("falls back to service check and returns ok when services exist", async () => {
    const provider = createProvider();
    let callCount = 0;
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        callCount++;
        if (cmd.includes("powershell")) {
          // PowerShell feature check fails
          cb(new Error("access denied"), "", "");
        } else {
          // sc query succeeds for service fallback
          cb(null, "SERVICE_NAME: ok\n", "");
        }
      },
    );

    const result = await (provider as any)._checkWindowsFeatures();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("Hyper-V & Containers enabled");
    provider.dispose();
  });

  it("returns warn when all checks fail", async () => {
    const provider = createProvider();
    // _getFeatureState rejects (powershell fails)
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => {
        cb(new Error("fail"), "", "");
      },
    );
    // _isServiceInstalled never throws (it catches internally), so to
    // trigger the outer catch we mock it to reject on the provider.
    jest.spyOn(provider as any, "_isServiceInstalled").mockRejectedValue(
      new Error("unexpected"),
    );

    const result = await (provider as any)._checkWindowsFeatures();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("Could not verify");
    provider.dispose();
  });
});

// ─── _checkDockerEngine ──────────────────────────────────────────

describe("_checkDockerEngine", () => {
  it("returns error when docker is not installed", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => {
        cb(new Error("not found"), "", "");
      },
    );

    const result = await (provider as any)._checkDockerEngine();
    expect(result.status).toBe("error");
    expect(result.detail).toBe("Not installed");
    provider.dispose();
  });

  it("returns warn when docker is installed but not running", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 24.0.7, build afdd53b\n", "");
        } else {
          cb(new Error("daemon not running"), "", "");
        }
      },
    );

    const result = await (provider as any)._checkDockerEngine();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("24.0.7");
    expect(result.detail).toContain("not running");
    provider.dispose();
  });

  it("returns ok when docker is installed and running", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 24.0.7, build afdd53b\n", "");
        } else {
          cb(null, "Server: Docker Engine\n", "");
        }
      },
    );

    const result = await (provider as any)._checkDockerEngine();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("24.0.7");
    provider.dispose();
  });
});

// ─── isAllHealthy ────────────────────────────────────────────────

describe("isAllHealthy", () => {
  it("returns true when all checks are ok", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 24.0.7, build afdd53b\n", "");
        } else if (cmd.includes("powershell")) {
          // Feature state queries must return "Enabled"
          cb(null, "Enabled\n", "");
        } else {
          cb(null, "ok\n", "");
        }
      },
    );
    await (provider as any)._runChecks();

    expect(provider.isAllHealthy).toBe(true);
    provider.dispose();
  });

  it("returns false when any check is not ok", async () => {
    const provider = createProvider();
    // Docker not installed → error
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => {
        cb(new Error("fail"), "", "");
      },
    );
    await (provider as any)._runChecks();

    expect(provider.isAllHealthy).toBe(false);
    provider.dispose();
  });
});

// ─── startDockerEngine (static) ──────────────────────────────────

describe("DockerHealthProvider.startDockerEngine", () => {
  it("returns true when first service name succeeds", async () => {
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(null); },
    );

    const result = await DockerHealthProvider.startDockerEngine();
    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("com.docker.service"),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns true when first fails but second succeeds", async () => {
    let callCount = 0;
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => {
        callCount++;
        if (callCount === 1) {
          cb(new Error("service not found"));
        } else {
          cb(null);
        }
      },
    );

    const result = await DockerHealthProvider.startDockerEngine();
    expect(result).toBe(true);
    expect(callCount).toBe(2);
  });

  it("returns false when all service names fail", async () => {
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(new Error("fail")); },
    );

    const result = await DockerHealthProvider.startDockerEngine();
    expect(result).toBe(false);
  });
});

// ─── HealthCheckItem - status icons ──────────────────────────────

describe("HealthCheckItem - status icons", () => {
  const { HealthCheckItem } = require("./dockerHealthProvider");

  it("uses pass-filled icon with green color for ok status", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "ok", detail: "All good",
    });
    expect((item.iconPath as any).id).toBe("pass-filled");
    expect((item.iconPath as any).color.id).toBe("charts.green");
  });

  it("uses warning icon with yellow color for warn status", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "warn", detail: "Warning",
    });
    expect((item.iconPath as any).id).toBe("warning");
    expect((item.iconPath as any).color.id).toBe("charts.yellow");
  });

  it("uses error icon with red color for error status", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "error", detail: "Bad",
    });
    expect((item.iconPath as any).id).toBe("error");
    expect((item.iconPath as any).color.id).toBe("charts.red");
  });

  it("uses sync~spin icon for checking status", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "checking", detail: "...",
    });
    expect((item.iconPath as any).id).toBe("sync~spin");
  });
});

// ─── HealthCheckItem - fixCommand ────────────────────────────────

describe("HealthCheckItem - fixCommand", () => {
  const { HealthCheckItem } = require("./dockerHealthProvider");

  it("sets command when fixCommand is provided", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "error", detail: "Bad",
      fixCommand: "myExtension.fix",
    });
    expect(item.command).toBeDefined();
    expect(item.command!.command).toBe("myExtension.fix");
  });

  it("leaves command undefined when fixCommand is not provided", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "ok", detail: "Good",
    });
    expect(item.command).toBeUndefined();
  });
});

// ─── HealthCheckItem - tooltip ───────────────────────────────────

describe("HealthCheckItem - tooltip", () => {
  const { HealthCheckItem } = require("./dockerHealthProvider");

  it("tooltip contains OK for ok status", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "ok", detail: "Fine",
    });
    expect((item.tooltip as any).value).toContain("OK");
  });

  it("tooltip contains Not Available for error status", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "error", detail: "Bad",
    });
    expect((item.tooltip as any).value).toContain("Not Available");
  });

  it("tooltip contains Click to fix when fixCommand is set", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "error", detail: "Bad",
      fixCommand: "myExtension.fix",
    });
    expect((item.tooltip as any).value).toContain("Click to fix");
  });

  it("tooltip does not contain Click to fix when fixCommand is absent", () => {
    const item = new HealthCheckItem({
      id: "test", label: "Test", status: "error", detail: "Bad",
    });
    expect((item.tooltip as any).value).not.toContain("Click to fix");
  });
});

// ─── DockerHealthProvider.getChildren ────────────────────────────

describe("DockerHealthProvider.getChildren", () => {
  it("returns HealthCheckItem array after running checks", async () => {
    const { HealthCheckItem } = require("./dockerHealthProvider");
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 24.0.7, build afdd53b\n", "");
        } else if (cmd.includes("powershell")) {
          cb(null, "Enabled\n", "");
        } else {
          cb(null, "ok\n", "");
        }
      },
    );
    await (provider as any)._runChecks();

    const children = await provider.getChildren();
    expect(Array.isArray(children)).toBe(true);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((c: any) => c instanceof HealthCheckItem)).toBe(true);
    provider.dispose();
  });
});

// ─── DockerHealthProvider.dispose ────────────────────────────────

describe("DockerHealthProvider.dispose", () => {
  it("makes _runChecks a no-op after dispose", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 24.0.7, build afdd53b\n", "");
        } else if (cmd.includes("powershell")) {
          cb(null, "Enabled\n", "");
        } else {
          cb(null, "ok\n", "");
        }
      },
    );
    await (provider as any)._runChecks();
    const healthyBefore = provider.isAllHealthy;

    provider.dispose();

    // Sabotage exec so any real call would flip isAllHealthy
    mockExec.mockImplementation(
      (_cmd: string, _opts: any, cb: any) => { cb(new Error("fail"), "", ""); },
    );
    await (provider as any)._runChecks();
    expect(provider.isAllHealthy).toBe(healthyBefore);
  });

  it("clears the timer after dispose", () => {
    const provider = createProvider();
    provider.dispose();
    expect((provider as any)._timer).toBeUndefined();
  });
});

// ─── _checkWindowsFeatures - partial service availability ────────

describe("_checkWindowsFeatures - partial service availability", () => {
  it("returns error with Containers when vmms exists but vmcompute does not", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd.includes("powershell")) {
          cb(new Error("access denied"), "", "");
        } else if (cmd.includes("vmms")) {
          cb(null, "SERVICE_NAME: vmms\n", "");
        } else if (cmd.includes("vmcompute")) {
          cb(new Error("1060"), "", "");
        } else {
          cb(null, "", "");
        }
      },
    );

    const result = await (provider as any)._checkWindowsFeatures();
    expect(result.status).toBe("error");
    expect(result.detail).toContain("Containers");
    provider.dispose();
  });
});

// ─── _checkDockerEngine - version format variations ──────────────

describe("_checkDockerEngine - version format variations", () => {
  it("extracts 27.5.1 from standard version string", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 27.5.1, build afdd53b4e3\n", "");
        } else {
          cb(null, "Server: Docker Engine\n", "");
        }
      },
    );

    const result = await (provider as any)._checkDockerEngine();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("27.5.1");
    provider.dispose();
  });

  it("extracts 24.0.7-ce from CE version string", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 24.0.7-ce, build 311b9ff\n", "");
        } else {
          cb(null, "Server: Docker Engine\n", "");
        }
      },
    );

    const result = await (provider as any)._checkDockerEngine();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("24.0.7-ce");
    provider.dispose();
  });

  it("extracts 20.10.24+azure-2 from azure version string", async () => {
    const provider = createProvider();
    mockExec.mockImplementation(
      (cmd: string, _opts: any, cb: any) => {
        if (cmd === "docker --version") {
          cb(null, "Docker version 20.10.24+azure-2, build 297e128\n", "");
        } else {
          cb(null, "Server: Docker Engine\n", "");
        }
      },
    );

    const result = await (provider as any)._checkDockerEngine();
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("20.10.24+azure-2");
    provider.dispose();
  });
});
