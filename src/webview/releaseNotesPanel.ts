import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

type SectionType = "Added" | "Changed" | "Improved" | "Fixed" | "Removed";

interface ReleaseSection { type: SectionType; items: string[]; }
interface ReleaseEntry   { version: string; date: string; sections: ReleaseSection[]; }

const KNOWN_SECTIONS = new Set<string>(["Added", "Changed", "Improved", "Fixed", "Removed"]);
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

export class ReleaseNotesPanel {
  private static _instance:        ReleaseNotesPanel | undefined;
  private static _cachedReleases:  ReleaseEntry[]    | undefined;
  private static _extensionUri:    vscode.Uri        | undefined;
  private static _currentVersion:  string            | undefined;

  private readonly _panel: vscode.WebviewPanel;

  private constructor(releases: ReleaseEntry[], showOnUpdate: boolean) {
    this._panel = vscode.window.createWebviewPanel(
      "bcDockerManager.releaseNotes",
      "What's New - BC Docker Manager",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this._panel.webview.html = buildHtml(this._panel.webview, releases, showOnUpdate);
    this._panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "setShowOnUpdate") {
        vscode.workspace
          .getConfiguration("bcDockerManager")
          .update("showReleaseNotesOnUpdate", msg.value as boolean, vscode.ConfigurationTarget.Global);
      }
    });
    this._panel.onDidDispose(() => { ReleaseNotesPanel._instance = undefined; });
  }

  /** Called once during activate() so show() never needs context. */
  static init(context: vscode.ExtensionContext): void {
    ReleaseNotesPanel._extensionUri   = context.extensionUri;
    ReleaseNotesPanel._currentVersion = context.extension.packageJSON.version as string;
  }

  static show(): void {
    if (ReleaseNotesPanel._instance) {
      ReleaseNotesPanel._instance._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const releases     = ReleaseNotesPanel._releases();
    const showOnUpdate = vscode.workspace
      .getConfiguration("bcDockerManager")
      .get<boolean>("showReleaseNotesOnUpdate", true);
    ReleaseNotesPanel._instance = new ReleaseNotesPanel(releases, showOnUpdate);
  }

  static showIfUpdated(context: vscode.ExtensionContext): void {
    ReleaseNotesPanel.init(context);
    const cfg = vscode.workspace.getConfiguration("bcDockerManager");
    if (!cfg.get<boolean>("showReleaseNotesOnUpdate", true)) { return; }
    const key     = "bcDockerManager.lastSeenVersion";
    const current = ReleaseNotesPanel._currentVersion ?? "";
    if (context.globalState.get<string>(key) === current) { return; }
    context.globalState.update(key, current);
    ReleaseNotesPanel.show();
  }

  // ── internals ──────────────────────────────────────────────────

  private static _releases(): ReleaseEntry[] {
    if (ReleaseNotesPanel._cachedReleases) { return ReleaseNotesPanel._cachedReleases; }

    // Lazy fallback: if init() was somehow skipped, resolve via extensions API.
    if (!ReleaseNotesPanel._extensionUri) {
      const ext = vscode.extensions.getExtension("jeffreybulanadi.bc-docker-manager");
      if (ext) {
        ReleaseNotesPanel._extensionUri   = ext.extensionUri;
        ReleaseNotesPanel._currentVersion = ext.packageJSON.version as string;
      }
    }

    if (!ReleaseNotesPanel._extensionUri) {
      ReleaseNotesPanel._cachedReleases = [];
      return [];
    }

    try {
      const mdPath = path.join(ReleaseNotesPanel._extensionUri.fsPath, "CHANGELOG.md");
      const text   = fs.readFileSync(mdPath, "utf-8");
      ReleaseNotesPanel._cachedReleases = parseChangelog(text);
    } catch {
      ReleaseNotesPanel._cachedReleases = [];
    }
    return ReleaseNotesPanel._cachedReleases;
  }
}

// ── CHANGELOG parser ────────────────────────────────────────────

function parseChangelog(text: string): ReleaseEntry[] {
  const releases: ReleaseEntry[] = [];

  // Each block starts after "## "
  for (const block of text.split(/^## /m).slice(1)) {
    const lines   = block.split("\n");
    const header  = lines[0];
    const headerM = header.match(/^\[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
    if (!headerM) { continue; }

    const version  = headerM[1];
    const date     = fmtDate(headerM[2]);
    const sections: ReleaseSection[] = [];
    let   current:  ReleaseSection | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      const secM = line.match(/^### (.+)/);
      if (secM) {
        const type = secM[1].trim();
        current = KNOWN_SECTIONS.has(type)
          ? (sections.push({ type: type as SectionType, items: [] }), sections[sections.length - 1])
          : null;
        continue;
      }

      const itemM = line.match(/^- (.+)/);
      if (itemM && current) {
        current.items.push(stripMd(itemM[1].trim()));
      }
    }

    const valid = sections.filter(s => s.items.length > 0);
    if (valid.length > 0) { releases.push({ version, date, sections: valid }); }
  }

  return releases;
}

function fmtDate(iso: string): string {
  const [y, m] = iso.split("-");
  return `${MONTHS[(parseInt(m, 10) - 1)] ?? ""} ${y}`;
}

/** Strip common inline markdown to plain text. */
function stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")          // **bold**
    .replace(/\*([^*]+)\*/g,     "$1")           // *italic*
    .replace(/`([^`]+)`/g,       "$1")           // `code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")     // [text](url)
    .replace(/_([^_]+)_/g,       "$1");           // _italic_
}

// ── HTML builder ────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function buildHtml(webview: vscode.Webview, releases: ReleaseEntry[], showOnUpdate: boolean): string {
  const n        = crypto.randomBytes(16).toString("hex");
  const current  = ReleaseNotesPanel["_currentVersion"] ?? releases[0]?.version ?? "";
  const checked  = showOnUpdate ? "checked" : "";

  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${n}'`,
  ].join("; ");

  const tabs = releases.map((r, i) =>
    `<button class="v-tab${i === 0 ? " active" : ""}" data-v="${esc(r.version)}" role="tab" aria-selected="${i === 0}">`
    + esc(r.version)
    + (r.version === current ? `<span class="chip">Latest</span>` : "")
    + `</button>`
  ).join("\n      ");

  const panels = releases.map((r, i) => {
    const sections = r.sections.map(s => {
      const items = s.items.map(it => `<li>${esc(it)}</li>`).join("");
      return `<section><span class="badge badge--${s.type.toLowerCase()}">${esc(s.type)}</span><ul>${items}</ul></section>`;
    }).join("");

    return `<div class="rp${i === 0 ? " active" : ""}" id="v${esc(r.version)}" role="tabpanel">`
      + `<div class="meta"><span class="rv">${esc(r.version)}</span><span class="rd">${esc(r.date)}</span>`
      + (r.version === current ? `<span class="current-chip">Current</span>` : "")
      + `</div>${sections}</div>`;
  }).join("\n    ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>What's New</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);background:var(--vscode-editor-background);overflow:hidden}
.shell{display:flex;flex-direction:column;height:100vh}

/* Header */
.hdr{flex-shrink:0;padding:24px 40px 0;background:var(--vscode-editor-background)}
.brand{font-size:.75em;font-weight:600;letter-spacing:.07em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);margin-bottom:4px}
.title{font-size:1.55em;font-weight:700;margin-bottom:20px;line-height:1.2}

/* Tab bar */
.tabs{display:flex;overflow-x:auto;scrollbar-width:none;
  border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.3))}
.tabs::-webkit-scrollbar{display:none}
.v-tab{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;padding:8px 16px;
  background:transparent;border:none;border-bottom:2px solid transparent;
  color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:.87em;
  cursor:pointer;white-space:nowrap;opacity:.65;margin-bottom:-1px}
.v-tab:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.v-tab.active{opacity:1;font-weight:600;color:var(--vscode-textLink-foreground);
  border-bottom-color:var(--vscode-textLink-foreground)}
.chip{padding:1px 7px;border-radius:10px;font-size:.7em;font-weight:700;
  background:var(--vscode-textLink-foreground);color:var(--vscode-editor-background);line-height:1.6}

/* Content */
.content{flex:1;overflow-y:auto;padding:28px 40px 16px;max-width:820px}
.rp{display:none}.rp.active{display:block}
.meta{display:flex;align-items:baseline;gap:12px;margin-bottom:24px;padding-bottom:14px;
  border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.2))}
.rv{font-size:1.3em;font-weight:700}
.rd{font-size:.88em;color:var(--vscode-descriptionForeground)}
.current-chip{padding:2px 9px;border-radius:11px;font-size:.72em;font-weight:700;
  background:color-mix(in srgb,var(--vscode-textLink-foreground) 14%,transparent);
  color:var(--vscode-textLink-foreground);
  border:1px solid color-mix(in srgb,var(--vscode-textLink-foreground) 35%,transparent)}

/* Sections */
section{margin-bottom:24px}
.badge{display:inline-flex;padding:2px 9px;border-radius:3px;font-size:.7em;font-weight:700;
  text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
.badge--added{background:color-mix(in srgb,var(--vscode-charts-green,#89d185) 16%,transparent);
  color:var(--vscode-charts-green,#89d185);
  border:1px solid color-mix(in srgb,var(--vscode-charts-green,#89d185) 32%,transparent)}
.badge--changed,.badge--improved{
  background:color-mix(in srgb,var(--vscode-textLink-foreground) 14%,transparent);
  color:var(--vscode-textLink-foreground);
  border:1px solid color-mix(in srgb,var(--vscode-textLink-foreground) 32%,transparent)}
.badge--fixed{background:color-mix(in srgb,var(--vscode-charts-orange,#d18616) 16%,transparent);
  color:var(--vscode-charts-orange,#d18616);
  border:1px solid color-mix(in srgb,var(--vscode-charts-orange,#d18616) 32%,transparent)}
.badge--removed{background:color-mix(in srgb,var(--vscode-charts-red,#f14c4c) 16%,transparent);
  color:var(--vscode-charts-red,#f14c4c);
  border:1px solid color-mix(in srgb,var(--vscode-charts-red,#f14c4c) 32%,transparent)}
ul{list-style:none;padding:0}
li{position:relative;padding:7px 0 7px 15px;line-height:1.55;font-size:.92em;
  border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.1))}
li:last-child{border-bottom:none}
li::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);
  width:3px;height:55%;border-radius:2px;opacity:.45;
  background:var(--vscode-widget-border,rgba(128,128,128,.5))}
section:has(.badge--added) li::before{background:var(--vscode-charts-green,#89d185)}
section:has(.badge--changed) li::before,
section:has(.badge--improved) li::before{background:var(--vscode-textLink-foreground)}
section:has(.badge--fixed) li::before{background:var(--vscode-charts-orange,#d18616)}
section:has(.badge--removed) li::before{background:var(--vscode-charts-red,#f14c4c)}

/* Footer */
.footer{flex-shrink:0;display:flex;align-items:center;padding:12px 40px;
  border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.3));
  background:var(--vscode-editor-background)}
.cb-row{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;
  font-size:.87em;color:var(--vscode-foreground)}
.cb-row input[type=checkbox]{appearance:none;-webkit-appearance:none;
  width:16px;height:16px;border:1px solid var(--vscode-checkbox-border,rgba(128,128,128,.6));
  background:var(--vscode-checkbox-background,transparent);
  border-radius:3px;cursor:pointer;position:relative;flex-shrink:0}
.cb-row input[type=checkbox]:checked{
  background:var(--vscode-checkbox-selectBackground,var(--vscode-textLink-foreground));
  border-color:var(--vscode-checkbox-selectBackground,var(--vscode-textLink-foreground))}
.cb-row input[type=checkbox]:checked::after{content:"";position:absolute;
  left:4px;top:1px;width:5px;height:9px;
  border:1.5px solid var(--vscode-checkbox-foreground,#fff);
  border-top:none;border-left:none;transform:rotate(45deg)}
.cb-row input[type=checkbox]:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
</style>
</head>
<body>
<div class="shell">
  <header class="hdr">
    <div class="brand">BC Docker Manager</div>
    <div class="title">What's New</div>
    <nav class="tabs" role="tablist" aria-label="Version history">
      ${tabs}
    </nav>
  </header>
  <div class="content">
    ${panels}
  </div>
  <footer class="footer">
    <label class="cb-row">
      <input type="checkbox" id="chk" ${checked}>
      <span>Show this page after each update</span>
    </label>
  </footer>
</div>
<script nonce="${n}">
(function(){
  var api=acquireVsCodeApi();
  document.querySelectorAll(".v-tab").forEach(function(tab){
    tab.addEventListener("click",function(){
      document.querySelectorAll(".v-tab").forEach(function(t){t.classList.remove("active");t.setAttribute("aria-selected","false");});
      document.querySelectorAll(".rp").forEach(function(p){p.classList.remove("active");});
      tab.classList.add("active");tab.setAttribute("aria-selected","true");
      var p=document.getElementById("v"+tab.getAttribute("data-v"));
      if(p){p.classList.add("active");}
    });
  });
  document.getElementById("chk").addEventListener("change",function(e){
    api.postMessage({command:"setShowOnUpdate",value:e.target.checked});
  });
}());
</script>
</body>
</html>`;
}
