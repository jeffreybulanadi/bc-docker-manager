/**
 * Minimal VS Code API stub for Jest unit tests.
 * Only the surface area used by the tested source modules is stubbed.
 * This file is referenced by jest.config.js moduleNameMapper.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const window = {
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  showOpenDialog: jest.fn().mockResolvedValue(undefined),
  showSaveDialog: jest.fn().mockResolvedValue(undefined),
  showTextDocument: jest.fn().mockResolvedValue(undefined),
  showWorkspaceFolderPick: jest.fn().mockResolvedValue(undefined),
  createTerminal: jest.fn().mockReturnValue({ show: jest.fn() }),
  createOutputChannel: jest.fn().mockReturnValue({
    appendLine: jest.fn(),
    append: jest.fn(),
    show: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
  }),
  createWebviewPanel: jest.fn().mockReturnValue({
    webview: {
      html: "",
      onDidReceiveMessage: jest.fn(),
      postMessage: jest.fn().mockResolvedValue(true),
      asWebviewUri: jest.fn((uri: any) => uri),
      cspSource: "https://test.csp",
    },
    onDidDispose: jest.fn(),
    reveal: jest.fn(),
    dispose: jest.fn(),
    visible: true,
  }),
  withProgress: jest.fn().mockImplementation((_opts: any, task: (p: any) => Promise<any>) =>
    task({ report: jest.fn() })
  ),
};

const workspace = {
  workspaceFolders: undefined as any,
  openTextDocument: jest.fn().mockResolvedValue({}),
  getConfiguration: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  }),
};

const env = {
  clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  openExternal: jest.fn().mockResolvedValue(undefined),
};

const commands = {
  executeCommand: jest.fn().mockResolvedValue(undefined),
  registerCommand: jest.fn(),
};

const Uri = {
  parse: jest.fn((s: string) => ({ toString: () => s, fsPath: s, scheme: "file" })),
  file: jest.fn((p: string) => ({ toString: () => `file:///${p}`, fsPath: p, scheme: "file" })),
  joinPath: jest.fn((base: any, ...segments: string[]) => {
    const joined = [base.fsPath || base.toString(), ...segments].join("/");
    return { toString: () => joined, fsPath: joined, scheme: "file" };
  }),
};

const ViewColumn = { One: 1, Two: 2, Three: 3, Active: -1, Beside: -2 };
const ProgressLocation = { Notification: 15 };
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

class TreeItem {
  label: string | undefined;
  collapsibleState: number | undefined;
  description?: string;
  contextValue?: string;
  iconPath?: any;
  tooltip?: any;
  command?: any;
  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon { constructor(public id: string, public color?: any) {} }
class ThemeColor { constructor(public id: string) {} }
class MarkdownString { constructor(public value: string) {} }

class EventEmitter {
  event = jest.fn();
  fire = jest.fn();
  dispose = jest.fn();
}

module.exports = {
  window, workspace, env, commands, Uri,
  ViewColumn, ProgressLocation, TreeItemCollapsibleState, ConfigurationTarget,
  TreeItem, ThemeIcon, ThemeColor, MarkdownString, EventEmitter,
};
