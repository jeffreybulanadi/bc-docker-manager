# Changelog

All notable changes to **BC Docker Manager** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [1.3.3] - 2026-05-01

### Added

- Edit Container Profile command. Previously the only way to update a saved profile was to overwrite it by saving again with the same name, which required retyping every field from scratch. The new Edit command loads an existing profile into a step-by-step flow with each field pre-filled so you only change what you need. Isolation and authentication modes are shown as a pick list with the current value highlighted. Leaving country or license path empty clears those optional fields.

- Delete Container Profile command is now visible in the Containers panel toolbar menu alongside Save, Load, and Edit. Previously it was only reachable via the command palette.

### Changed

- Load Container Profile now writes the stored values back to VS Code user settings immediately when you select a profile. Previously the profile was returned but the values were never applied, so loading a profile had no visible effect. Memory limit, isolation, auth, DNS, and country are all written on load. Country is only written when the profile includes one, to avoid clearing an existing country preference unintentionally.

- All file transfers between the host and Hyper-V containers now go through a single persistent `docker exec` spawn instead of spawning a new PowerShell process per chunk. License upload, app publish, database backup, database restore, and AL compilation previously opened one process every 5-50 KB of data. On a 500 MB backup that was roughly 10,000 process starts at ~400 ms each. The transfer now streams through one long-lived process, keeping a 48 KB sliding window in memory regardless of file size, and completes in seconds rather than hours.

- SQL Server Express edition is now detected automatically before each backup attempt. When Express is detected, the `COMPRESSION` option is omitted from the `BACKUP DATABASE` statement. Previously the command failed with `BACKUP DATABASE WITH COMPRESSION is not supported on Express`, requiring the user to switch editions manually.

- PowerShell ANSI color escape sequences are stripped from error messages before they are shown in VS Code notifications. The raw terminal codes were leaking into toasts and output channel messages as garbled characters.

---

## [1.3.1] - 2025-05-01

### Changed

- Changing country while a specific BC major version (e.g. BC25) was selected showed 0 results. The filter state was reset on country change but the major dropdown kept its previous selection, causing the client-side major filter to exclude all rows returned by the unfiltered `getLatestVersions` fetch (which returns the most recent N versions, typically a different major). The extension now passes the selected major with the country-change request and fetches `getMajorVersions` and `getVersionsByMajor` in parallel, returning the major-specific results directly. If the selected major has no releases in the new country, the extension sends a `majorNotFound` signal so the frontend resets the filter to show all versions.
- Changing the artifact tab (Sandbox vs OnPrem) while a major was selected could produce 0 results for the same reason. The tab change handler now resets the major dropdown to "All" before loading, since a tab switch is an explicit context change rather than a cross-country comparison.
- Country dropdown was rebuilt from scratch on every `countries` message without restoring the previously selected value. The selection is now preserved using the same pattern as the major dropdown.

---



## [1.3.0] - 2025-05-01

### Added
- Phase-aware progress during container initialization. The VS Code notification and the sidebar both show the current BC initialization phase (Downloading artifact, Installing prerequisites, Configuring SQL Server, Importing license, Installing Business Central, Ready) as the container starts up.
- Immediate sidebar placeholder. A spinning placeholder item appears the moment you start container creation, before Docker even reports the container exists. Previously the sidebar showed nothing for up to 5 minutes.
- Phase overlay on real containers. Once Docker reports the container, the placeholder is replaced by a real container item with the current phase shown as its description and a spinner icon. The icon and description clear automatically when the container is ready.
- Cancellation support. The initialization progress toast now has a Cancel button. Clicking it stops the health-check loop and removes the container with `docker rm -f`, then clears the sidebar placeholder. Previously there was no way to abort a stuck initialization.
- Completion toast with quick actions. When initialization finishes, a notification appears with two buttons: "Open BC Web Client" opens the BC login page directly, and "Generate launch.json" creates the AL project configuration.

### Changed
- Container initialization progress is now driven by the phase-change callback (`onPhase`) instead of a fixed 30-second interval. The sidebar and notification update every time a new phase is detected in the container logs, so progress is shown as fast as the container reports it.

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
