/**
 * Unit tests for LaunchJsonService.
 *
 * Pure functions (buildConfig, stripJsonComments) and file-system operations
 * (mergeConfig) are tested using a real temp directory so no mocking is needed.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LaunchJsonService, ContainerLaunchInfo } from "./launchJsonService";

// ─────────────────────────── buildConfig ────────────────────────

describe("LaunchJsonService.buildConfig", () => {
  const minimal: ContainerLaunchInfo = { containerName: "mybc" };

  it("sets type=al and request=launch", () => {
    const cfg = LaunchJsonService.buildConfig(minimal);
    expect(cfg.type).toBe("al");
    expect(cfg.request).toBe("launch");
  });

  it("builds server URL as https://<containerName>", () => {
    const cfg = LaunchJsonService.buildConfig(minimal);
    expect(cfg.server).toBe("https://mybc");
  });

  it("applies defaults for optional fields", () => {
    const cfg = LaunchJsonService.buildConfig(minimal);
    expect(cfg.serverInstance).toBe("BC");
    expect(cfg.authentication).toBe("UserPassword");
    expect(cfg.port).toBe(7049);
    expect(cfg.environmentType).toBe("OnPrem");
    expect(cfg.startupObjectId).toBe(22);
    expect(cfg.startupObjectType).toBe("Page");
    expect(cfg.launchBrowser).toBe(true);
    expect(cfg.breakOnError).toBe("All");
    expect(cfg.enableLongRunningSqlStatements).toBe(true);
    expect(cfg.enableSqlInformationDebugger).toBe(true);
  });

  it("uses overridden auth, port, and serverInstance", () => {
    const cfg = LaunchJsonService.buildConfig({
      containerName: "mybc",
      authentication: "Windows",
      port: 7050,
      serverInstance: "DEV",
    });
    expect(cfg.authentication).toBe("Windows");
    expect(cfg.port).toBe(7050);
    expect(cfg.serverInstance).toBe("DEV");
  });

  it("sets name equal to containerName", () => {
    const cfg = LaunchJsonService.buildConfig(minimal);
    expect(cfg.name).toBe("mybc");
  });

  it("does not include tenant field by default", () => {
    const cfg = LaunchJsonService.buildConfig(minimal);
    expect(cfg.tenant).toBeUndefined();
  });
});

// ─────────────────────────── stripJsonComments ──────────────────

describe("LaunchJsonService.stripJsonComments", () => {
  const strip = LaunchJsonService.stripJsonComments.bind(LaunchJsonService);

  it("returns plain JSON unchanged", () => {
    const input = '{"a":1}';
    expect(strip(input)).toBe(input);
  });

  it("removes // line comments", () => {
    const input = '{\n  "a": 1 // a comment\n}';
    const result = strip(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it("removes /* block */ comments", () => {
    const input = '{ /* block */ "a": 1 }';
    const result = strip(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it("does not strip // inside a string value", () => {
    const input = '{"url":"http://example.com"}';
    const result = strip(input);
    expect(JSON.parse(result)).toEqual({ url: "http://example.com" });
  });

  it("does not strip /* inside a string value", () => {
    const input = '{"note":"a /* b */ c"}';
    const result = strip(input);
    expect(JSON.parse(result)).toEqual({ note: "a /* b */ c" });
  });

  it("handles escaped quotes inside strings", () => {
    const input = '{"s":"he said \\"hello\\" // not a comment"}';
    const result = strip(input);
    expect(JSON.parse(result)).toEqual({ s: 'he said "hello" // not a comment' });
  });

  it("strips BOM (\\uFEFF) at the start", () => {
    const input = "\uFEFF{\"a\":1}";
    const result = strip(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });
});

// ─────────────────────────── mergeConfig ────────────────────────

describe("LaunchJsonService.mergeConfig", () => {
  let tmpDir: string;
  let launchPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-test-"));
    launchPath = path.join(tmpDir, ".vscode", "launch.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeConfig = (name: string) =>
    LaunchJsonService.buildConfig({ containerName: name });

  it("creates launch.json and .vscode directory when they don't exist", async () => {
    await LaunchJsonService.mergeConfig(launchPath, makeConfig("bc1"));
    expect(fs.existsSync(launchPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(launchPath, "utf-8"));
    expect(content.version).toBe("0.2.0");
    expect(content.configurations).toHaveLength(1);
    expect(content.configurations[0].name).toBe("bc1");
  });

  it("appends a new config when file exists with different names", async () => {
    await LaunchJsonService.mergeConfig(launchPath, makeConfig("bc1"));
    await LaunchJsonService.mergeConfig(launchPath, makeConfig("bc2"));
    const content = JSON.parse(fs.readFileSync(launchPath, "utf-8"));
    expect(content.configurations).toHaveLength(2);
    expect(content.configurations.map((c: { name: string }) => c.name)).toEqual(["bc1", "bc2"]);
  });

  it("replaces existing config with the same name", async () => {
    await LaunchJsonService.mergeConfig(launchPath, makeConfig("bc1"));
    const updated = { ...makeConfig("bc1"), port: 9999 };
    await LaunchJsonService.mergeConfig(launchPath, updated);
    const content = JSON.parse(fs.readFileSync(launchPath, "utf-8"));
    expect(content.configurations).toHaveLength(1);
    expect(content.configurations[0].port).toBe(9999);
  });

  it("handles JSONC files with // comments", async () => {
    const vsDir = path.join(tmpDir, ".vscode");
    fs.mkdirSync(vsDir, { recursive: true });
    fs.writeFileSync(launchPath, '// top comment\n{"version":"0.2.0","configurations":[]}\n', "utf-8");
    await LaunchJsonService.mergeConfig(launchPath, makeConfig("bc1"));
    const content = JSON.parse(fs.readFileSync(launchPath, "utf-8"));
    expect(content.configurations).toHaveLength(1);
  });

  it("handles file with UTF-8 BOM without creating a backup", async () => {
    const vsDir = path.join(tmpDir, ".vscode");
    fs.mkdirSync(vsDir, { recursive: true });
    // Write valid JSON with BOM prepended
    const withBom = "\uFEFF" + JSON.stringify({ version: "0.2.0", configurations: [] });
    fs.writeFileSync(launchPath, withBom, "utf-8");
    // Should parse cleanly — no backup file should appear
    await LaunchJsonService.mergeConfig(launchPath, makeConfig("bc1"));
    const backups = fs.readdirSync(vsDir).filter((f) => f.includes("backup"));
    expect(backups).toHaveLength(0);
    const content = JSON.parse(fs.readFileSync(launchPath, "utf-8"));
    expect(content.configurations).toHaveLength(1);
  });

  it("backs up and recreates on corrupt JSON", async () => {
    const vsDir = path.join(tmpDir, ".vscode");
    fs.mkdirSync(vsDir, { recursive: true });
    fs.writeFileSync(launchPath, "{ not valid json {{{", "utf-8");
    await LaunchJsonService.mergeConfig(launchPath, makeConfig("bc1"));
    const files = fs.readdirSync(vsDir);
    const backups = files.filter((f) => f.includes("backup"));
    expect(backups).toHaveLength(1);
    const content = JSON.parse(fs.readFileSync(launchPath, "utf-8"));
    expect(content.configurations).toHaveLength(1);
  });
});
