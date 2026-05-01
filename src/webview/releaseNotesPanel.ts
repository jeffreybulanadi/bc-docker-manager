import * as vscode from "vscode";

const CURRENT_VERSION = "1.5.0";

interface ReleaseSection {
  heading: string;
  items: string[];
}

interface ReleaseEntry {
  version: string;
  sections: ReleaseSection[];
}

// Release notes are intentionally hardcoded here so the panel works
// without reading from disk and can be localised independently of CHANGELOG.md.
const RELEASE: ReleaseEntry = {
  version: CURRENT_VERSION,
  sections: [
    {
      heading: "Added",
      items: [
        "Container tags - right-click any container and choose Set Container Tags to attach comma-separated labels (e.g. client1, sandbox, v25). Tags appear inline in the container list so you can see them at a glance without hovering.",
        "Container notes - right-click any container and choose Set Container Note to attach a free-text note. The note is shown at the bottom of the container tooltip and persists across restarts and recreations.",
        "Clear annotations - a single Clear Container Note and Tags command removes all annotations from a container in one step.",
        "What's New panel - this panel. Opens automatically when a new version is installed. Reopen any time from the Command Palette: BC Docker Manager: What's New.",
      ],
    },
    {
      heading: "Improved",
      items: [
        "Container name input now blocks creation if the name contains uppercase letters or underscores. BC uses the name as a DNS hostname and SSL certificate CN - both are invalid in hostnames per RFC 952/1123.",
        "When a container stops or dies before BC finishes initializing, the last 50 lines of container logs are shown in the output channel so the cause is visible immediately. Networking setup is skipped entirely in this case.",
        "Memory setting without a unit suffix (e.g. '8' instead of '8G') is now automatically treated as gigabytes. Docker requires a unit - a bare number meant 8 bytes, causing the container to exit immediately.",
        "Container IP detection now validates that the result is a well-formed IPv4 address. Previously any non-empty string from docker inspect was accepted, including daemon warnings that ended up in networking URLs.",
        "Container export sanitizes the temporary image tag to lowercase before calling docker commit, so containers with mixed-case names can now be exported without error.",
      ],
    },
  ],
};

export class ReleaseNotesPanel {
  private static _instance: ReleaseNotesPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;

  private constructor() {
    this._panel = vscode.window.createWebviewPanel(
      "bcDockerManager.releaseNotes",
      `What's New in BC Docker Manager ${CURRENT_VERSION}`,
      vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: false },
    );
    this._panel.webview.html = buildHtml(RELEASE);
    this._panel.onDidDispose(() => {
      ReleaseNotesPanel._instance = undefined;
    });
  }

  static show(): void {
    if (ReleaseNotesPanel._instance) {
      ReleaseNotesPanel._instance._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    ReleaseNotesPanel._instance = new ReleaseNotesPanel();
  }

  static showIfUpdated(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration("bcDockerManager");
    if (!config.get<boolean>("showReleaseNotesOnUpdate", true)) { return; }

    const key = "bcDockerManager.lastSeenVersion";
    if (context.globalState.get<string>(key) === CURRENT_VERSION) { return; }

    context.globalState.update(key, CURRENT_VERSION);
    ReleaseNotesPanel.show();
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(release: ReleaseEntry): string {
  const sections = release.sections
    .map((s) => {
      const items = s.items.map((i) => `<li>${escHtml(i)}</li>`).join("\n");
      return `<section>\n<h2>${escHtml(s.heading)}</h2>\n<ul>\n${items}\n</ul>\n</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>What's New - BC Docker Manager ${escHtml(release.version)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.6;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 40px 56px;
    max-width: 800px;
  }
  .header { margin-bottom: 36px; }
  .header h1 { font-size: 1.5em; font-weight: 700; margin-bottom: 4px; }
  .header p { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  section { margin-bottom: 28px; }
  h2 {
    font-size: 0.78em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--vscode-textLink-foreground);
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
    padding-bottom: 5px;
    margin-bottom: 12px;
  }
  ul { list-style: disc; padding-left: 22px; }
  li { margin-bottom: 9px; }
  .footer {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
  }
  code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.2));
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.9em;
  }
</style>
</head>
<body>
<div class="header">
  <h1>What's New in BC Docker Manager</h1>
  <p>Version ${escHtml(release.version)}</p>
</div>
${sections}
<p class="footer">
  To stop seeing this on update, set
  <code>bcDockerManager.showReleaseNotesOnUpdate</code> to <code>false</code> in your VS Code settings.<br>
  Reopen any time: Command Palette &gt; <strong>BC Docker Manager: What's New</strong>.
</p>
</body>
</html>`;
}
