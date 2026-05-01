import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const EXTENSION_ID = "jeffreybulanadi.bc-docker-manager";

// Regex compiled once at module load - used in the markdown parser hot loop.
const HR_RE = /^-{3,}$/;

// Exact styles from VS Code's markdownDocumentRenderer.ts (DEFAULT_MARKDOWN_STYLES).
const VSCODE_MARKDOWN_STYLES = `
body {
  padding: 10px 20px;
  line-height: 22px;
  max-width: 882px;
  margin: 0 auto;
}
body *:last-child { margin-bottom: 0; }
img { max-width: 100%; max-height: 100%; }
a { text-decoration: var(--text-link-decoration); }
a:hover { text-decoration: underline; }
a:focus, input:focus, select:focus, textarea:focus {
  outline: 1px solid -webkit-focus-ring-color;
  outline-offset: -1px;
}
hr { border: 0; height: 2px; border-bottom: 2px solid; }
h1 { padding-bottom: 0.3em; line-height: 1.2; border-bottom-width: 1px; border-bottom-style: solid; }
h1, h2, h3 { font-weight: normal; }
table { border-collapse: collapse; }
th { text-align: left; border-bottom: 1px solid; }
th, td { padding: 5px 10px; }
table > tbody > tr + tr > td { border-top-width: 1px; border-top-style: solid; }
blockquote { margin: 0 7px 0 5px; padding: 0 16px 0 10px; border-left-width: 5px; border-left-style: solid; }
code { font-family: "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace; }
pre { padding: 16px; border-radius: 3px; overflow: auto; }
pre code {
  font-family: var(--vscode-editor-font-family);
  font-weight: var(--vscode-editor-font-weight);
  font-size: var(--vscode-editor-font-size);
  line-height: 1.5;
  color: var(--vscode-editor-foreground);
  tab-size: 4;
}
.vscode-high-contrast h1 { border-color: rgb(0, 0, 0); }
.vscode-light th { border-color: rgba(0, 0, 0, 0.69); }
.vscode-dark  th { border-color: rgba(255, 255, 255, 0.69); }
.vscode-light h1, .vscode-light hr, .vscode-light td { border-color: rgba(0, 0, 0, 0.18); }
.vscode-dark  h1, .vscode-dark  hr, .vscode-dark  td { border-color: rgba(255, 255, 255, 0.18); }

/* ── footer ── */
.rn-footer {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  margin-top: 32px;
  border-top: 1px solid;
  font-size: 0.9em;
  background: var(--vscode-editor-background);
  cursor: pointer;
  user-select: none;
}
.vscode-light .rn-footer { border-color: rgba(0,0,0,.18); }
.vscode-dark  .rn-footer { border-color: rgba(255,255,255,.18); }
.rn-footer input[type=checkbox] {
  appearance: none; -webkit-appearance: none;
  width: 16px; height: 16px;
  border: 1px solid var(--vscode-checkbox-border, rgba(128,128,128,.6));
  background: var(--vscode-checkbox-background, transparent);
  border-radius: 3px; cursor: pointer; position: relative; flex-shrink: 0;
}
.rn-footer input[type=checkbox]:checked {
  background: var(--vscode-checkbox-selectBackground, var(--vscode-textLink-foreground));
  border-color: var(--vscode-checkbox-selectBackground, var(--vscode-textLink-foreground));
}
.rn-footer input[type=checkbox]:checked::after {
  content: ""; position: absolute; left: 4px; top: 1px;
  width: 5px; height: 9px;
  border: 1.5px solid var(--vscode-checkbox-foreground, #fff);
  border-top: none; border-left: none; transform: rotate(45deg);
}
.rn-footer input[type=checkbox]:focus-visible {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
}
`;

export class ReleaseNotesPanel {
  private static _instance:           ReleaseNotesPanel | undefined;
  private static _cachedMarkdownHtml: string            | undefined;
  private static _extensionUri:       vscode.Uri        | undefined;
  private static _currentVersion:     string            | undefined;

  private readonly _panel: vscode.WebviewPanel;

  private constructor(showOnUpdate: boolean) {
    this._panel = vscode.window.createWebviewPanel(
      "bcDockerManager.releaseNotes",
      "What's New - BC Docker Manager",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    this._panel.webview.html = buildHtml(
      ReleaseNotesPanel._markdownHtml(),
      showOnUpdate,
    );
    this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "setShowOnUpdate") {
        vscode.workspace
          .getConfiguration("bcDockerManager")
          .update("showReleaseNotesOnUpdate", msg.value as boolean, vscode.ConfigurationTarget.Global);
      }
    });
    this._panel.onDidDispose(() => { ReleaseNotesPanel._instance = undefined; });
  }

  /** Called once in activate() to store extension context. */
  static init(context: vscode.ExtensionContext): void {
    ReleaseNotesPanel._extensionUri   = context.extensionUri;
    ReleaseNotesPanel._currentVersion = context.extension.packageJSON.version as string;
  }

  static show(showOnUpdate?: boolean): void {
    if (ReleaseNotesPanel._instance) {
      ReleaseNotesPanel._instance._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const flag = showOnUpdate ??
      vscode.workspace.getConfiguration("bcDockerManager").get<boolean>("showReleaseNotesOnUpdate", true);
    ReleaseNotesPanel._instance = new ReleaseNotesPanel(flag);
  }

  static showIfUpdated(context: vscode.ExtensionContext): void {
    ReleaseNotesPanel.init(context);
    const showOnUpdate = vscode.workspace
      .getConfiguration("bcDockerManager")
      .get<boolean>("showReleaseNotesOnUpdate", true);
    if (!showOnUpdate) { return; }
    const key     = "bcDockerManager.lastSeenVersion";
    const current = ReleaseNotesPanel._currentVersion ?? "";
    if (context.globalState.get<string>(key) === current) { return; }
    context.globalState.update(key, current);
    ReleaseNotesPanel.show(showOnUpdate);
  }

  /**
   * Read and convert CHANGELOG.md to HTML once; reuse on subsequent opens.
   * CHANGELOG.md in the extension root is the SINGLE SOURCE OF TRUTH for release notes.
   * To ship a new release: update CHANGELOG.md + package.json version only.
   * Do NOT hardcode release notes in this file.
   */
  private static _markdownHtml(): string {
    if (ReleaseNotesPanel._cachedMarkdownHtml !== undefined) {
      return ReleaseNotesPanel._cachedMarkdownHtml;
    }

    // Lazy fallback: init() should always be called first via showIfUpdated/show.
    if (!ReleaseNotesPanel._extensionUri) {
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      if (ext) {
        ReleaseNotesPanel._extensionUri   = ext.extensionUri;
        ReleaseNotesPanel._currentVersion = ext.packageJSON.version as string;
      }
    }

    let mdText = "";
    if (ReleaseNotesPanel._extensionUri) {
      try {
        mdText = fs.readFileSync(
          path.join(ReleaseNotesPanel._extensionUri.fsPath, "CHANGELOG.md"),
          "utf-8",
        );
      } catch { /* panel will render empty on catastrophic failure */ }
    }

    // Drop the "# Changelog" title - the panel title bar already says "What's New".
    mdText = mdText.replace(/^# .+\n/, "").trimStart();

    const html = mdToHtml(mdText);
    // Only cache on success; a failed read leaves the cache empty so the next
    // open retries the file read instead of permanently serving blank content.
    if (mdText) { ReleaseNotesPanel._cachedMarkdownHtml = html; }
    return html;
  }
}

// ── Minimal markdown-to-HTML renderer ────────────────────────────────────────
// Handles the subset used in CHANGELOG.md: h1-h3, ul/li, hr, inline code,
// bold, links, and paragraphs. Deliberately no external dependency.

function mdToHtml(md: string): string {
  const lines = md.split("\n");
  const out:   string[] = [];
  let inUl = false;

  const closeUl = () => { if (inUl) { out.push("</ul>"); inUl = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith("### ")) {
      closeUl();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      closeUl();
      const text = line.slice(3);
      out.push(`<h2 id="${slug(text)}">${inline(text)}</h2>`);
    } else if (line.startsWith("# ")) {
      closeUl();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith("- ")) {
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (HR_RE.test(line)) {
      closeUl();
      out.push("<hr>");
    } else if (line === "") {
      closeUl();
    } else {
      closeUl();
      out.push(`<p>${inline(line)}</p>`);
    }
  }

  closeUl();
  return out.join("");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

/** Convert inline markdown to HTML-safe markup. */
function inline(raw: string): string {
  // Escape HTML characters first so user content cannot inject tags.
  let s = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // Inline code (before bold so backtick content is left alone).
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Links - open in system browser (VS Code handles external hrefs automatically).
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return s;
}

// ── HTML page builder ─────────────────────────────────────────────────────────

function buildHtml(markdownHtml: string, showOnUpdate: boolean): string {
  const n       = crypto.randomBytes(16).toString("hex");
  const checked = showOnUpdate ? "checked" : "";

  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${n}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>What's New - BC Docker Manager</title>
<style>${VSCODE_MARKDOWN_STYLES}</style>
</head>
<body>
${markdownHtml}
<footer class="rn-footer">
  <input type="checkbox" id="chk" ${checked}>
  <label for="chk">Show this page after each update</label>
</footer>
<script nonce="${n}">
(function () {
  var api = acquireVsCodeApi();
  document.getElementById("chk").addEventListener("change", function (e) {
    api.postMessage({ command: "setShowOnUpdate", value: e.target.checked });
  });
}());
</script>
</body>
</html>`;
}
