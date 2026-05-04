import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const EXTENSION_ID = "jeffreybulanadi.bc-docker-manager";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SectionText  { kind: "text";  text: string; }
interface SectionImage { kind: "image"; alt: string; src: string; }
type SectionItem = SectionText | SectionImage;

interface ReleaseSection { name: string; items: SectionItem[]; }
interface Release        { version: string; fmtDate: string; sections: ReleaseSection[]; }

// ── Styles ────────────────────────────────────────────────────────────────────

// Verbatim from VS Code markdownDocumentRenderer.ts DEFAULT_MARKDOWN_STYLES.
// body: layout div controls max-width/padding instead of body directly.
const BASE_CSS = `
body { padding: 0; line-height: 22px; max-width: none; margin: 0; }
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
/* ── layout ── */
.rn-layout { display: flex; min-height: 100vh; }
.rn-sidebar {
  width: 220px; flex-shrink: 0;
  padding: 28px 12px 40px 20px;
  box-sizing: border-box;
}
.rn-main {
  flex: 1; min-width: 0;
  padding: 28px 48px 60px 36px;
  max-width: 860px;
  box-sizing: border-box;
}

/* ── sidebar meta (version badge + date) ── */
.rn-toc { position: sticky; top: 28px; }
.rn-sidebar-meta { margin-bottom: 16px; }
.rn-version-badge {
  display: inline-block;
  font-size: .75em; font-weight: 700; letter-spacing: .05em;
  padding: 2px 9px; border-radius: 10px;
  background: var(--vscode-badge-background, rgba(128,128,128,.18));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  margin-bottom: 5px;
}
.rn-release-date {
  display: block;
  font-size: .78em; opacity: .55;
}

/* ── TOC nav ── */
.rn-toc-label {
  display: block;
  font-size: .72em; font-weight: 600; opacity: .5;
  text-transform: uppercase; letter-spacing: .08em;
  margin: 14px 0 8px;
}
.rn-toc ul { margin: 0; padding: 0; list-style: none; }
.rn-toc ul li { margin: 2px 0; }
.rn-toc a {
  text-decoration: none; font-size: .86em;
  display: block; padding: 3px 0 3px 10px;
  color: var(--vscode-foreground);
  opacity: .6;
  border-left: 2px solid transparent;
  transition: opacity .15s, color .15s, border-color .15s;
  line-height: 1.4;
}
.rn-toc a:hover { opacity: 1; text-decoration: none; }
.rn-toc a[aria-current="true"] {
  opacity: 1;
  color: var(--vscode-textLink-foreground);
  border-left-color: var(--vscode-textLink-foreground);
}

/* ── header ── */
.rn-header h1 {
  border-bottom: none; padding-bottom: 0; margin-bottom: 4px;
  font-size: 1.9em; font-weight: 600;
}
.rn-tagline { font-style: italic; opacity: .5; font-size: .88em; margin: 2px 0 10px; }
.rn-date    { opacity: .6; font-size: .85em; margin: 0 0 14px; }
.rn-header hr { margin: 18px 0 0; border-bottom-width: 1px; }

/* ── checkbox setting ── */
.rn-setting {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: .9em; cursor: pointer; user-select: none; margin-bottom: 10px;
}
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

/* ── social links ── */
.rn-social { font-size: .82em; opacity: .55; }
.rn-social a { opacity: 1; }

/* ── section heading (small-caps label + horizontal rule) ── */
.rn-section-wrap {
  display: flex; align-items: center;
  margin: 2em 0 .75em;
}
.rn-section-label {
  font-size: .78em; font-weight: 700;
  text-transform: uppercase; letter-spacing: .08em;
  opacity: .55; white-space: nowrap;
}
.rn-section-rule {
  flex: 1; height: 1px;
  background: var(--vscode-panel-border, rgba(128,128,128,.15));
  margin-left: 12px;
}

/* ── highlights card grid ── */
.rn-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  margin: 0 0 1em;
}
.rn-card {
  padding: 14px 16px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18));
  border-radius: 6px;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.06));
  line-height: 1.5;
}
.rn-card-title {
  font-weight: 700; font-size: .92em;
  display: block; margin-bottom: 4px;
}
.rn-card-desc { font-size: .88em; opacity: .8; }

/* ── contributor chips ── */
.rn-contributors { padding: 0; margin: 0; list-style: none; }
.rn-contributors li { margin: 6px 0; line-height: 1.6; }
a.rn-contributor {
  display: inline-block;
  padding: 1px 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  border-radius: 20px;
  font-size: .85em;
  text-decoration: none;
  color: var(--vscode-foreground);
  transition: color .15s, border-color .15s;
  margin-right: 6px;
}
a.rn-contributor:hover {
  color: var(--vscode-textLink-foreground);
  border-color: var(--vscode-textLink-foreground);
  text-decoration: none;
}
.rn-contributor-desc { font-size: .9em; opacity: .8; }

/* ── screenshots ── */
.rn-figure { margin: 16px 0; }
.rn-figure img { border-radius: 4px; max-height: 360px; object-fit: contain; }
.vscode-light .rn-figure img { box-shadow: 0 2px 8px rgba(0,0,0,.15); }
.vscode-dark  .rn-figure img { box-shadow: 0 2px 12px rgba(0,0,0,.55); }
.rn-figure figcaption { font-size: .8em; opacity: .55; margin-top: 6px; }

/* ── previous releases ── */
.rn-older-label {
  display: block;
  font-size: .75em; font-weight: 600; opacity: .5;
  text-transform: uppercase; letter-spacing: .08em;
  margin: 2.5em 0 10px;
}
details.rn-older {
  margin: 6px 0;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18));
  border-radius: 4px;
}
details.rn-older > summary {
  padding: 10px 16px; cursor: pointer; list-style: none;
  display: flex; justify-content: space-between; align-items: center;
  user-select: none; font-size: .93em;
}
details.rn-older > summary::-webkit-details-marker { display: none; }
.vscode-light details.rn-older > summary { background: rgba(0,0,0,.02); }
.vscode-dark  details.rn-older > summary { background: rgba(255,255,255,.02); }
.rn-chevron {
  display: inline-block; transition: transform .2s;
  opacity: .4; font-size: .85em; margin-left: 8px;
}
details.rn-older[open] .rn-chevron { transform: rotate(90deg); }
.rn-older-meta { display: flex; align-items: center; gap: 12px; }
.rn-older-date { opacity: .55; font-size: .82em; }
.rn-older-body { padding: 4px 20px 18px; }
.rn-older-body .rn-section-wrap { margin: 1.2em 0 .5em; }
.rn-older-body .rn-section-label { font-size: .72em; opacity: .45; }
.rn-older-body .rn-section-rule  { opacity: .6; }

/* ── responsive: hide sidebar below 580px ── */
@media (max-width: 580px) {
  .rn-sidebar { display: none; }
  .rn-main { padding: 20px 20px 40px; }
}
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

    const extUri = ReleaseNotesPanel._extensionUri!;
    this._panel = vscode.window.createWebviewPanel(
      "bcDockerManager.releaseNotes",
      label,
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extUri] },
    );

    const toUri = (rel: string): string => {
      try {
        return this._panel.webview.asWebviewUri(vscode.Uri.joinPath(extUri, rel)).toString();
      } catch { return ""; }
    };

    this._panel.webview.html = buildHtml(this._panel.webview, releases, showOnUpdate, toUri);

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

      const items: SectionItem[] = [];
      for (const l of sec.split("\n").slice(1)) {
        if (l.startsWith("- ") || l.startsWith("* ")) {
          const text = l.slice(2).trim();
          if (text) { items.push({ kind: "text", text }); }
        } else {
          const imgM = l.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
          if (imgM) { items.push({ kind: "image", alt: imgM[1], src: imgM[2] }); }
        }
      }

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

function buildHtml(
  webview: vscode.Webview,
  releases: Release[],
  showOnUpdate: boolean,
  toUri: (rel: string) => string,
): string {
  const nonce   = crypto.randomBytes(16).toString("hex");
  const checked = showOnUpdate ? " checked" : "";

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  let body: string;
  if (releases.length) {
    const sidebar = renderSidebar(releases[0]);
    const main    = renderCurrentMain(releases[0], checked, toUri)
                  + renderOlderList(releases.slice(1), toUri);
    body = `<aside class="rn-sidebar">${sidebar}</aside><main class="rn-main">${main}</main>`;
  } else {
    body = `<main class="rn-main"><p>No release notes available.</p></main>`;
  }

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
<div class="rn-layout">
${body}
</div>
<script nonce="${nonce}">(function(){
  var api = acquireVsCodeApi();
  var chk = document.getElementById("chk");
  if (chk) {
    chk.addEventListener("change", function(e){
      api.postMessage({ command: "setShowOnUpdate", value: e.target.checked });
    });
  }
  var links = document.querySelectorAll(".rn-toc a[data-target]");
  if (links.length && "IntersectionObserver" in window) {
    var map = Object.create(null);
    links.forEach(function(l){ map[l.getAttribute("data-target")] = l; });
    var active = null;
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting) {
          if (active) { active.removeAttribute("aria-current"); }
          active = map[e.target.id];
          if (active) { active.setAttribute("aria-current", "true"); }
        }
      });
    }, { rootMargin: "-5% 0px -75% 0px" });
    Object.keys(map).forEach(function(id){
      var el = document.getElementById(id);
      if (el) { io.observe(el); }
    });
  }
}());</script>
</body>
</html>`;
}

function renderSidebar(r: Release): string {
  const items = r.sections
    .map(s => `<li><a href="#${slug(s.name)}" data-target="${slug(s.name)}">${esc(s.name)}</a></li>`)
    .join("");
  return `<div class="rn-sidebar-meta">
  <span class="rn-version-badge">v${esc(r.version)}</span>
  <span class="rn-release-date">${esc(r.fmtDate)}</span>
</div>
<nav class="rn-toc">
  <span class="rn-toc-label">In this update</span>
  <ul>${items}</ul>
</nav>`;
}

const SOCIAL_LINKS =
  '<a href="https://www.linkedin.com/in/jeffreybulanadi/">LinkedIn</a>' +
  ' | <a href="https://x.com/JeffreyBulanadi">X</a>' +
  ' | <a href="https://bsky.app/profile/jeffreybulanadi.bsky.social">Bluesky</a>' +
  ' | <a href="https://learnbeyondbc.com">learnbeyondbc.com</a>';

function renderCurrentMain(r: Release, checked: string, toUri: (rel: string) => string): string {
  const sections = r.sections
    .map(s => renderSection(s, toUri))
    .join("");

  return `<div class="rn-header">
<h1>BC Docker Manager ${esc(r.version)}</h1>
<p class="rn-tagline">Written by a developer, for developers.</p>
<p class="rn-date">Released ${esc(r.fmtDate)}</p>
<label class="rn-setting"><input type="checkbox" id="chk"${checked}> Show release notes after an update</label>
<p class="rn-social">Follow on ${SOCIAL_LINKS}</p>
<hr>
</div>
${sections}`;
}

function renderSection(s: ReleaseSection, toUri: (rel: string) => string): string {
  return `<section id="${slug(s.name)}">${renderSectionHeading(s.name)}${renderSectionContent(s, toUri)}</section>`;
}

function renderSectionHeading(name: string): string {
  return `<div class="rn-section-wrap"><span class="rn-section-label">${esc(name)}</span><span class="rn-section-rule"></span></div>`;
}

function renderSectionContent(s: ReleaseSection, toUri: (rel: string) => string): string {
  if (s.name.toLowerCase() === "highlights") { return renderHighlightsCards(s.items); }
  if (s.name.toLowerCase() === "thank you")  { return renderContributorChips(s.items); }
  return renderSectionItems(s.items, toUri);
}

function parseCard(text: string): { title: string; desc: string } | null {
  const m = text.match(/^\*\*(.+?)\*\*[:\s]\s*(.+)/);
  return m ? { title: m[1], desc: m[2] } : null;
}

function renderHighlightsCards(items: SectionItem[]): string {
  const cards = items
    .filter((item): item is SectionText => item.kind === "text")
    .map(item => {
      const card = parseCard(item.text);
      if (card) {
        return `<div class="rn-card"><span class="rn-card-title">${esc(card.title)}</span><span class="rn-card-desc">${inline(card.desc)}</span></div>`;
      }
      return `<div class="rn-card"><span class="rn-card-desc">${inline(item.text)}</span></div>`;
    })
    .join("");
  return `<div class="rn-cards">${cards}</div>`;
}

function renderContributorChips(items: SectionItem[]): string {
  const chips = items
    .filter((item): item is SectionText => item.kind === "text")
    .map(item => {
      const m = item.text.match(/^\[(@[^\]]+)\]\(([^)]+)\)\s*-\s*(.+)/);
      if (m) {
        return `<li><a class="rn-contributor" href="${esc(m[2])}">${esc(m[1])}</a><span class="rn-contributor-desc">${inline(m[3])}</span></li>`;
      }
      return `<li>${inline(item.text)}</li>`;
    })
    .join("");
  return `<ul class="rn-contributors">${chips}</ul>`;
}

function renderSectionItems(items: SectionItem[], toUri: (rel: string) => string): string {
  const out: string[] = [];
  let inList = false;
  for (const item of items) {
    if (item.kind === "image") {
      if (inList) { out.push("</ul>"); inList = false; }
      const uri = toUri(item.src);
      if (uri) {
        out.push(`<figure class="rn-figure"><img src="${uri}" alt="${esc(item.alt)}" loading="lazy"><figcaption>${esc(item.alt)}</figcaption></figure>`);
      }
    } else {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(item.text)}</li>`);
    }
  }
  if (inList) { out.push("</ul>"); }
  return out.join("");
}

function renderOlderList(older: Release[], toUri: (rel: string) => string): string {
  if (!older.length) { return ""; }

  const items = older.map(r => {
    const sections = r.sections
      .map(s => renderSectionHeading(s.name) + renderSectionContent(s, toUri))
      .join("");

    return `<details class="rn-older">
<summary><span class="rn-older-meta"><span>${esc(r.version)}</span><span class="rn-older-date">${esc(r.fmtDate)}</span></span><span class="rn-chevron">&#8250;</span></summary>
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
