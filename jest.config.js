/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      tsconfig: "tsconfig.json",
      // Skip TS type-checking in tests — we're not re-validating TS here
      diagnostics: false,
    }],
  },
  // Stub the vscode module so tests can import source files that use vscode APIs
  moduleNameMapper: {
    "^vscode$": "<rootDir>/src/vscode-mock.ts",
  },
};
