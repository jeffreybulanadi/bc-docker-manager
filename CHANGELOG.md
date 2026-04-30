# Changelog

All notable changes to **BC Docker Manager** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [1.2.0] - 2026-04-30

### Added
- **BC Artifacts sidebar section**: a dedicated "BC Artifacts" panel in the BC Docker Manager activity bar with a one-click *Open BC Artifacts Explorer* button. No more digging through the command palette.
- Globe and Refresh icon buttons in the BC Artifacts section title bar for quick access and panel reload.

### Improved
- **Halved Docker CLI calls per tree refresh**: `getBcContainers()` now reuses the already-fetched container list instead of issuing a second `docker ps` + `docker inspect` pair. Two round-trips became one.
- **Volume SWR cache (30 s TTL)**: `getVolumes()` now returns cached data on rapid refreshes instead of querying Docker on every panel repaint. Cache is invalidated immediately after create/remove operations.
- **NAV exec split**: `execInContainer()` (utility PowerShell commands like `Test-Path`, `Remove-Item`, `Invoke-Sqlcmd`) no longer prepends the `NavAdminTool.ps1` wildcard import. A new `execNavInContainer()` carries that cost only for commands that actually need NAV cmdlets.
- **CDN URL constant**: `bcArtifactsService` now uses the `CDN_BASE` constant in `_parseVersions()`. Previously the URL was duplicated inline, which would silently break artifact URLs if the CDN endpoint ever changed.
- **O(1) pending-write cleanup**: `_pendingWrites` upgraded from `Array` (O(n) filter on completion) to `Set` (O(1) delete).
- **Artifacts Explorer auto-open**: the panel now opens automatically only on first install, not on every VS Code launch.

### Fixed
- `DockerService` EventEmitter was not disposed on extension deactivation. It is now registered in `context.subscriptions` via `implements vscode.Disposable`.

---

## [1.1.0] - 2026-03-31

### Fixed
- Add BC User and Add Test Users commands failed with *New-NAVServerUser is not recognized*. NAV management module (`NavAdminTool.ps1`) is now imported before executing NAV cmdlets inside Docker containers.

---

## [1.0.13] - 2026-03-20

### Fixed
- Extension crashed on startup (*command not found: bcDockerManager.refreshEnvironment*) because `node_modules` was excluded from the VSIX. Removed `node_modules/**` from `.vscodeignore` so production dependencies are packaged correctly.
- Removed unused `sharp` dependency.

---

## [1.0.0] - 2024-02-01

### Added
- Initial public release.
- BC Artifacts Explorer webview: browse, filter, and pull BC container images without BcContainerHelper.
- Container management tree view: start, stop, restart, and remove containers.
- Image management: pull BC images, pre-pull with progress, remove images.
- Volume management: create, remove, and inspect Docker volumes.
- Environment health panel: Hyper-V, Windows Containers, and Docker Engine status with one-click setup.
- AL developer tools: publish app, upload license, add users, backup/restore database, compile AL app, edit NST settings, view event log.
- `launch.json` generation, preview, and clipboard copy for AL projects.
- Container profiles: save and load container configurations.
- Bulk container operations: start all, stop all, remove all stopped.
- Azure Application Insights telemetry (opt-out via VS Code privacy settings).
