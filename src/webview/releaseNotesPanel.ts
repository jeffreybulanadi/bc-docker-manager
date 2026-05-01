import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const EXTENSION_ID = "jeffreybulanadi.bc-docker-manager";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReleaseSection { name: string; items: string[]; }
interface Release        { version: string; fmtDate: string; sections: ReleaseSection[]; }

// ── Styles ────────────────────────────────────────────────────────────────────

// Verbatim from VS Code markdownDocumentRenderer.ts DEFAULT_MARKDOWN_STYLES.
const BASE_CSS = `
body { padding: 10px 20px; line-height: 22px; max-width: 882px; margin: 0 auto; }
body *:last-child { margin-bottom: 0; }
img  { max-width: 100%; max-height: 100%; }
a    { text-decoration: var(--text-link-decoration); }
a:hover { text-decoration: underline; }
a:focus, input:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; }
hr   { border: 0; height: 2px; border-bottom: 2px solid; }
h1   { padding-bottom: 0.3em; line-height: 1.2; border-bottom-width: 1px; border-bottom-style: solid; }
h1, h2, h3 { font-weight: normal; }
table { border-collapse: collapse; }
th    { text-align: left; border-bottom: 1px solid; }
th, td { padding: 5px 10px; }
table > tbody > tr + tr > td { border-top-width: 1px; border-top-style: solid; }
blockquote { margin: 0 7px 0 5px; padding: 0 16px 0 10px; border-left-width: 5px; border-left-style: solid; }
code { font-family: "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace; }
pre  { padding: 16px; border-radius: 3px; overflow: auto; }
pre code {
  font-family: var(--vscode-editor-font-family);
  font-weight: var(--vscode-editor-font-weight);
  font-size:   var(--vscode-editor-font-size);
  line-height: 1.5; color: var(--vscode-editor-foreground); tab-size: 4;
}
.vscode-high-contrast h1 { border-color: rgb(0,0,0); }
.vscode-light th          { border-color: rgba(0,0,0,.69); }
.vscode-dark  th          { border-color: rgba(255,255,255,.69); }
.vscode-light h1,.vscode-light hr,.vscode-light td { border-color: rgba(0,0,0,.18); }
.vscode-dark  h1,.vscode-dark  hr,.vscode-dark  td { border-color: rgba(255,255,255,.18); }
`;

const PAGE_CSS = `
/* ── header ── */
.rn-header h1  { border-bottom: none; padding-bottom: 0; margin-bottom: 2px; font-size: 2em; }
.rn-date       { opacity: .7; font-size: .9em; margin: 4px 0 0; }

/* inline opt-out - matches VS Code's "Show release notes after an update" */
.rn-setting    { display: inline-flex; align-items: center; gap: 8px; font-size: .9em; cursor: pointer; user-select: none; margin-top: 14px; }
.rn-setting input[type=checkbox] {
  appearance: none; -webkit-appearance: none;
  width: 14px; height: 14px; flex-shrink: 0; cursor: pointer; position: relative;
  border: 1px solid var(--vscode-checkbox-border, rgba(128,128,128,.6));
  background: var(--vscode-checkbox-background, transparent);
  border-radius: 2px;
}
.rn-setting input[type=checkbox]:checked {
  background: var(--vscode-checkbox-selectBackground, var(--vscode-textLink-foreground));
  border-color: var(--vscode-checkbox-selectBackground, var(--vscode-textLink-foreground));
}
.rn-setting input[type=checkbox]:checked::after {
  content: ""; position: absolute; left: 3px; top: 0;
  width: 5px; height: 8px;
  border: 1.5px solid var(--vscode-checkbox-foreground, #fff);
  border-top: none; border-left: none; transform: rotate(45deg);
}
.rn-setting input[type=checkbox]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

/* ── table of contents - matches VS Code "In this update" box ── */
.rn-toc { margin: 2em 0; padding: 14px 20px; border-radius: 3px; border: 1px solid; }
.vscode-light .rn-toc { border-color: rgba(0,0,0,.12); background: rgba(0,0,0,.025); }
.vscode-dark  .rn-toc { border-color: rgba(255,255,255,.12); background: rgba(255,255,255,.025); }
.rn-toc > p  { font-weight: 600; margin: 0 0 8px; }
.rn-toc > ul { margin: 0; padding-left: 20px; }
.rn-toc > ul > li { margin: 3px 0; }

/* ── previous releases ── */
.rn-older-label { font-size: .82em; opacity: .55; text-transform: uppercase; letter-spacing: .07em; margin: 2.5em 0 8px; }
details.rn-older { margin: 5px 0; border: 1px solid; border-radius: 3px; }
.vscode-light details.rn-older { border-color: rgba(0,0,0,.12); }
.vscode-dark  details.rn-older { border-color: rgba(255,255,255,.12); }
details.rn-older > summary {
  padding: 9px 16px; cursor: pointer; list-style: none;
  display: flex; justify-content: space-between; align-items: center;
  user-select: none; font-size: .95em;
}
details.rn-older > summary::-webkit-details-marker { display: none; }
.vscode-light details.rn-older > summary { background: rgba(0,0,0,.025); }
.vscode-dark  details.rn-older > summary { background: rgba(255,255,255,.025); }
details.rn-older > summary::after       { content: "+"; opacity: .5; margin-left: 8px; }
details.rn-older[open] > summary::after { content: "-"; }
.rn-older-meta { display: flex; align-items: center; gap: 12px; }
.rn-older-date { opacity: .6; font-size: .85em; }
.rn-older-body { padding: 2px 20px 16px; }
.rn-older-body h3 { margin-top: 1.2em; margin-bottom: .5em; font-size: 1em; font-weight: 600 !important; }
`;

// ── Panel ─────────────────────────────────────────────────────────────────────

export class ReleaseNotesPanel {
  private static _instance:       ReleaseNotesPanel | undefined;
  private static _cachedReleases: Release[]          | undefined;
  private static _extensionUri:   vscode.Uri         | undefined;
  private static _currentVersion: string             | undefined;

  private readonly _panel: vscode.WebviewPanel;

  private constructor(releases: Release[], showOnUpdate: boolean) {
    const label = releases.length
      ? `BC Docker Manager ${releases[0].version} - Release Notes`
      : "BC Docker Manager - Release Notes";

    this._panel = vscode.window.createWebviewPanel(
      "bcDockerManager.releaseNotes",
      label,
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    this._panel.webview.html = buildHtml(releases, showOnUpdate);

    this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "setShowOnUpdate") {
        vscode.workspace
          .getConfiguration("bcDockerManager")
          .update("showReleaseNotesOnUpdate", msg.value as boolean, vscode.ConfigurationTarget.Global);
      }
    });

    this._panel.onDidDispose(() => { ReleaseNotesPanel._instance = undefined; });
  }

  /** Store extensionUri and version once; called in activate(). */
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
    ReleaseNotesPanel._instance = new ReleaseNotesPanel(ReleaseNotesPanel._releases(), flag);
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
   * Parse CHANGELOG.md into Release[]; result cached after first successful read.
   *
   * SINGLE SOURCE OF TRUTH: CHANGELOG.md (extension root) drives all release notes.
   * To publish a new release: update CHANGELOG.md + package.json version only.
   * Do NOT hardcode release notes in this file.
   */
  private static _releases(): Release[] {
    if (ReleaseNotesPanel._cachedReleases !== undefined) {
      return ReleaseNotesPanel._cachedReleases;
    }

    // Lazy fallback: init() should always have been called first via activate().
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
      } catch { /* leave empty; panel renders gracefully */ }
    }

    const releases = parseChangelog(mdText);
    // Cache only on success so a failed read retries on next open.
    if (releases.length) { ReleaseNotesPanel._cachedReleases = releases; }
    return releases;
  }
}

// ── CHANGELOG parser ──────────────────────────────────────────────────────────
// Handles standard Keep a Changelog format:
//   ## [x.y.z] - YYYY-MM-DD
//   ### Section
//   - item

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];

  for (const block of md.split(/\n(?=## \[)/)) {
    const head = block.match(/^## \[(\d+\.\d+\.\d+)\][^\n]*?(\d{4}-\d{2}-\d{2})/);
    if (!head) { continue; }

    const sections: ReleaseSection[] = [];

    for (const sec of block.split(/\n(?=### )/)) {
      const sHead = sec.match(/^### (.+)/);
      if (!sHead) { continue; }

      const items = sec
        .split("\n")
        .slice(1)
        .filter(l => l.startsWith("- "))
        .map(l => l.slice(2).trim())
        .filter(Boolean);

      if (items.length) { sections.push({ name: sHead[1].trim(), items }); }
    }

    if (sections.length) {
      const [y, m] = head[2].split("-");
      releases.push({
        version: head[1],
        fmtDate: `${MONTHS[parseInt(m, 10) - 1]} ${y}`,
        sections,
      });
    }
  }

  return releases;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(releases: Release[], showOnUpdate: boolean): string {
  const nonce   = crypto.randomBytes(16).toString("hex");
  const checked = showOnUpdate ? " checked" : "";

  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const body = releases.length
    ? renderCurrent(releases[0], checked) + renderOlderList(releases.slice(1))
    : "<p>No release notes available.</p>";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>BC Docker Manager - Release Notes</title>
<style>${BASE_CSS}${PAGE_CSS}</style>
</head>
<body>
${body}
<script nonce="${nonce}">(function(){
  var api = acquireVsCodeApi();
  document.getElementById("chk").addEventListener("change", function(e){
    api.postMessage({ command: "setShowOnUpdate", value: e.target.checked });
  });
}());</script>
</body>
</html>`;
}

function renderCurrent(r: Release, checked: string): string {
  const tocItems = r.sections
    .map(s => `<li><a href="#${slug(s.name)}">${esc(s.name)}</a></li>`)
    .join("");

  const sections = r.sections
    .map(s => `<h2 id="${slug(s.name)}">${esc(s.name)}</h2><ul>${
      s.items.map(i => `<li>${inline(i)}</li>`).join("")
    }</ul>`)
    .join("");

  return `<div class="rn-header">
<h1>BC Docker Manager ${esc(r.version)}</h1>
<p class="rn-date">Release date: ${esc(r.fmtDate)}</p>
<label class="rn-setting"><input type="checkbox" id="chk"${checked}> Show release notes after an update</label>
</div>
<nav class="rn-toc"><p>In this update</p><ul>${tocItems}</ul></nav>
${sections}`;
}

function renderOlderList(older: Release[]): string {
  if (!older.length) { return ""; }

  const items = older.map(r => {
    const sections = r.sections
      .map(s => `<h3>${esc(s.name)}</h3><ul>${
        s.items.map(i => `<li>${inline(i)}</li>`).join("")
      }</ul>`)
      .join("");

    return `<details class="rn-older">
<summary><span class="rn-older-meta"><span>${esc(r.version)}</span><span class="rn-older-date">${esc(r.fmtDate)}</span></span></summary>
<div class="rn-older-body">${sections}</div>
</details>`;
  }).join("");

  return `<hr><p class="rn-older-label">Previous releases</p>${items}`;
}

// ── Inline markdown helpers ───────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

function inline(raw: string): string {
  let s = esc(raw);
  // Inline code first - protects backtick content from further transforms.
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}
