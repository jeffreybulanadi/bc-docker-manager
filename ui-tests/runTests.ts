/**
 * ExTester runner - downloads VS Code + ChromeDriver, packages the extension,
 * and runs UI tests with Selenium WebDriver.
 *
 * First run is slow (~2 min for VS Code download + VSIX packaging).
 * Subsequent runs reuse the cached VS Code + ChromeDriver.
 */
import { ExTester } from "vscode-extension-tester";
import * as path from "path";

async function main() {
  const storageFolder = path.resolve(__dirname, "..", "..", ".extester");

  const tester = new ExTester(storageFolder);

  // Download VS Code and ChromeDriver (cached after first run)
  await tester.setupRequirements({ vscodeVersion: "latest" });

  // Point directly to test files using forward slashes
  const testsDir = path.resolve(__dirname).replace(/\\/g, "/");
  const testGlob = `${testsDir}/*.test.js`;

  console.log("Test glob:", testGlob);

  // Run the UI tests
  await tester.runTests(testGlob, {
    resources: [],
  });
}

main().catch((err) => {
  console.error("UI test run failed:", err);
  process.exit(1);
});
