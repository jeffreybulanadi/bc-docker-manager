# Changelog

All notable changes to **BC Docker Manager** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [1.2.2] - 2026-04-30

### Fixed
- Containers created via the extension were not visible when the BC filter was active. The filter used an exclusive fallback: it checked Docker labels (`nav`, `maintainer`) first, and only fell back to the image-name heuristic when zero labelled containers existed. Containers created by this extension use the generic `mcr.microsoft.com/businesscentral:ltsc2022` base image, which carries no labels until BC finishes initialisation. If any other labelled BC container was already running, the new container was silently excluded from the BC view. Reported in [#5](https://github.com/jeffreybulanadi/bc-docker-manager/issues/5), confirmed by `@kennetlindberg`.
- The filter is now inclusive: all three signals (label `nav`, label `maintainer=Dynamics SMB`, image-name heuristic) are evaluated in a single O(n) pass. A container matching any one signal appears in the BC view.
- The `docker run` command now stamps `--label nav=extension-created` on every container created by the extension so it is recognised immediately, even before BC initialisation completes.
- The container tree now refreshes 5 seconds after creation starts (so the container appears while BC is still initialising), then every 30 seconds throughout the initialisation process so the tree stays current. Previously the tree only refreshed after BC was fully ready (5-15 minutes later).

---

## [1.2.1] - 2026-04-30

### Fixed
- Extension settings were ignored when creating containers. `defaultIsolation`, `defaultMemory`, and `defaultAuth` were hardcoded in the container creation flow, so containers always used `hyperv` isolation and `8G` memory regardless of what was configured. Reported in [#3](https://github.com/jeffreybulanadi/bc-docker-manager/issues/3).
- `defaultCountry` setting was ignored when opening the Artifacts Explorer. The panel always loaded `us` on open instead of the configured country. Also reported in [#3](https://github.com/jeffreybulanadi/bc-docker-manager/issues/3).

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
