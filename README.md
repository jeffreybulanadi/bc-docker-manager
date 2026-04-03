# BC Docker Manager

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/jeffreybulanadi.bc-docker-manager?label=VS%20Code%20Marketplace&logo=visual-studio-code&color=0078d7)](https://marketplace.visualstudio.com/items?itemName=jeffreybulanadi.bc-docker-manager)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/jeffreybulanadi.bc-docker-manager?color=63ba83)](https://marketplace.visualstudio.com/items?itemName=jeffreybulanadi.bc-docker-manager)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A lightweight, all-in-one control center for **Business Central Docker development** inside VS Code.
> Browse artifacts, create containers, manage your environment, and develop AL apps - **without BcContainerHelper or Docker Desktop**.

<!-- SCREENSHOT: Full VS Code window showing the BC Docker Manager sidebar (all sections expanded)
     with a running container visible and the Artifacts Explorer open in the editor area.
     Aim for 1280x800 or larger. Save as: screenshots/hero.png -->
![BC Docker Manager Overview](screenshots/hero.png)

---

## Features at a Glance

| | Feature | What it does |
|---|---------|-------------|
| | [Artifacts Explorer](#bc-artifacts-explorer) | Browse & create containers from the Microsoft CDN |
| | [Container Management](#container-management) | Full lifecycle: start, stop, restart, remove, export, import |
| | [Environment Setup](#environment-setup) | One-click wizard for Hyper-V, Windows Containers & Docker Engine |
| | [AL Development](#al-development) | Generate launch.json, compile apps, publish to containers |
| | [Networking & SSL](#networking--ssl) | Auto-configure hosts file and install self-signed certificates |
| | [User Management](#user-management) | Create BC users and test users inside containers |
| | [Database Operations](#database-operations) | Backup and restore databases with a single click |
| | [Monitoring](#monitoring) | Live container stats, logs, and event log viewer |
| | [Profiles & Bulk Ops](#container-profiles--bulk-operations) | Save/load container configs, bulk start/stop/remove |

---

## BC Artifacts Explorer

Browse every Business Central artifact on the Microsoft CDN directly from VS Code. Switch between **Sandbox** and **OnPrem** tabs, filter by country and major version, then create a container in three clicks.

<!-- SCREENSHOT: The Artifacts Explorer webview with the SANDBOX tab active,
     a country selected (e.g. "us"), and the table populated with artifact rows.
     Show the search bar, country dropdown, and version dropdown at the top.
     Save as: screenshots/artifacts-explorer.png -->
![Artifacts Explorer](screenshots/artifacts-explorer.png)

- **Tabbed browsing** - Sandbox / OnPrem
- **Filter** by country, major version, or free-text search
- **Sortable columns** - click any header (version, country, date)
- **Infinite scroll** - pagination loads automatically as you scroll
- **One-click actions** - Copy Version, Copy URL, or **Create Container**
- **Smart caching** - stale-while-revalidate keeps data fresh without lag

### Container Creation Wizard

When you click **Create Container** on an artifact, a guided 3-step flow walks you through:

1. **Container name** (defaults to `bc<major><country>`, e.g. `bc25us`)
2. **Username** (default: `admin`)
3. **Password**
4. **EULA acceptance**

The extension then pulls the image, runs `docker run`, waits for the health check, and automatically configures networking, all with real-time progress in the output channel.

<!-- SCREENSHOT: The VS Code notification area showing container creation progress,
     e.g. "Pulling image..." or "Container bc25us is ready!" with the output channel visible below.
     Save as: screenshots/container-creation.png -->
![Container Creation](screenshots/container-creation.png)

---

## Container Management

Everything you need to manage your BC containers lives in the sidebar. Running containers get a green icon, stopped ones get gray.

<!-- SCREENSHOT: The Containers sidebar section with at least one running container and one stopped container visible.
     Show the inline action buttons (stop, restart, remove, web client, networking) on the running container.
     Save as: screenshots/containers-panel.png -->
![Containers Panel](screenshots/containers-panel.png)

### Lifecycle

| Action | How |
|--------|-----|
| **Start** | Click > on a stopped container |
| **Stop** | Click X on a running container |
| **Restart** | Click restart or right-click > Restart |
| **Remove** | Click trash or right-click > Remove |
| **Export** | Right-click > Export Container (saves as `.tar`) |
| **Import** | Toolbar > Import Container (loads a `.tar`) |

### Quick Access

- **Open Web Client** - launches `https://<container>/BC/` in your browser (auto-configures hosts + SSL first)
- **Open Terminal** - interactive PowerShell session inside the container
- **View Logs** - streams `docker logs` in real time
- **Copy IP** - copies the container's IP address to your clipboard
- **Show Stats** - live CPU, memory, network, and disk I/O (refreshes every 5 seconds)

### Context Menu

Right-click any container for the full action menu:

<!-- SCREENSHOT: Right-click context menu on a running container showing all menu groups:
     Container actions, Connection, BC Operations, BC Data, BC Pro Features, Advanced.
     Save as: screenshots/container-context-menu.png -->
![Container Context Menu](screenshots/container-context-menu.png)

---

## Environment Setup

The **Environment** panel checks your system health and tells you exactly what's missing. Click **Setup Everything** to fix it all in one go.

<!-- SCREENSHOT: The Environment sidebar section expanded, showing health check items.
     Ideally show a mix of statuses: green for items that pass, red or yellow for items that need attention.
     The "Setup Everything" rocket icon should be visible in the section toolbar.
     Save as: screenshots/environment-panel.png -->
![Environment Panel](screenshots/environment-panel.png)

**Health checks** (polled every 15 seconds):

| Check | What it verifies |
|-------|-----------------|
| Windows Features | Hyper-V & Windows Containers are enabled |
| Docker Engine | Docker is installed and the daemon is running |

**One-click fixes:**
- **Enable Hyper-V & Windows Containers** - runs `Enable-WindowsOptionalFeature` (requires reboot)
- **Install Docker Engine** - downloads the standalone engine from `download.docker.com` (no Docker Desktop needed)
- **Start Docker Engine** - starts the Docker Windows service if it's stopped

---

## AL Development

### launch.json Generation

Connect the [AL Language extension](https://marketplace.visualstudio.com/items?itemName=ms-dynamics-smb.al) to your container instantly:

| Command | What it does |
|---------|-------------|
| **Generate AL Launch Configuration** | Writes `.vscode/launch.json` to your workspace |
| **Preview launch.json in New Tab** | Opens the config in a read-only editor tab |
| **Copy launch.json to Clipboard** | Copies the JSON for manual pasting |

### Compile AL App

Compile your AL project **inside the container** using `alc.exe` - no local AL compiler needed:

1. Right-click a container > **Compile AL App in Container**
2. Select your workspace folder
3. The compiled `output.app` is copied back to your workspace root

### Publish AL App

Deploy your `.app` file directly:

1. Right-click a container > **Publish AL App to Container**
2. Select your `.app` file
3. The extension handles Publish > Sync > Install automatically

---

## Networking & SSL

BC containers use self-signed certificates and custom hostnames. This extension handles both:

| Command | What it does |
|---------|-------------|
| **Setup Networking** | Updates hosts file + installs SSL cert in one step |
| **Update Hosts File** | Maps container hostname > IP in `C:\Windows\System32\drivers\etc\hosts` |
| **Install SSL Certificate** | Extracts the container's cert and adds it to Windows Trusted Root |

> **Tip:** When you click **Open Web Client**, networking is configured automatically if it hasn't been already.

---

## User Management

| Command | What it does |
|---------|-------------|
| **Add BC User** | Create a user with a custom name, password, and permission set |
| **Add Test Users** | Creates 3 standard test users in one click |

**Test users created:**

| User | Permission Set | Password |
|------|---------------|----------|
| ESSENTIAL | SUPER | P@ssw0rd |
| PREMIUM | SUPER | P@ssw0rd |
| TEAMMEMBER | D365 TEAM MEMBER | P@ssw0rd |

---

## Database Operations

| Command | What it does |
|---------|-------------|
| **Backup Database** | Creates a compressed `.bak` file via SQL Server |
| **Restore Database** | Restores from backup (stops > restores > restarts the service tier) |

---

## Monitoring

| Command | What it does |
|---------|-------------|
| **Show Container Stats** | Live CPU, memory, network I/O, and block I/O (refreshes every 5 s) |
| **View Container Logs** | Streams `docker logs --follow` in a terminal |
| **View Event Log** | Retrieves Windows Event Log entries (MicrosoftDynamicsNavServer, MSSQL) |
| **Edit NST Settings** | View and edit NavServerTier configuration with optional service restart |

---

## Container Profiles & Bulk Operations

### Profiles

Save your container configuration (memory, isolation, auth, DNS, country, license path) and reapply it later:

| Command | What it does |
|---------|-------------|
| **Save Container Profile** | Saves current config to global storage |
| **Load Container Profile** | Creates a new container from a saved profile |
| **Delete Container Profile** | Removes a saved profile |

### Bulk Operations

| Command | What it does |
|---------|-------------|
| **Start All Stopped Containers** | Starts every stopped container in parallel |
| **Stop All Running Containers** | Stops every running container in parallel |
| **Remove All Stopped Containers** | Removes every stopped container in parallel |

---

## Images & Volumes

### Local Images

<!-- SCREENSHOT: The Local Images sidebar section showing one or more BC images.
     The filter toggle icon should be visible in the toolbar.
     Save as: screenshots/images-panel.png -->
![Images Panel](screenshots/images-panel.png)

- View all local Docker images (toggle **BC Filter** to show only Business Central images)
- **Pre-Pull BC Image** - download `mcr.microsoft.com/businesscentral:ltsc2022` ahead of time
- **Remove Image** - clean up unused images

### Volumes

- **Create Volume** - `docker volume create` with a custom name
- **Inspect Volume** - view driver and mountpoint details
- **Remove Volume** - delete unused volumes

---

## Getting Started

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Windows 10/11** or **Windows Server 2019+** | Required for Windows Containers |
| **Hyper-V** | The extension can enable this for you |
| **Docker Engine** | Standalone Windows service (Docker Desktop is optional) |

### Quick Start

1. **Install** the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jeffreybulanadi.bc-docker-manager)
2. **Open** the **BC Docker Manager** sidebar (look for the icon in the activity bar)
3. **Check** the **Environment** panel - click **Setup Everything** if anything is red
4. **Browse** the **BC Artifacts Explorer** - pick a version, country, and click **Create Container**
5. **Right-click** your new container for actions: web client, terminal, launch.json, and more

<!-- SCREENSHOT (optional): Annotated "getting started" image showing the activity bar icon
     with an arrow, the sidebar panels, and the artifacts explorer.
     Save as: screenshots/getting-started.png -->

---

## Commands

All commands are available from the Command Palette (`Ctrl+Shift+P`) under the **BC Docker Manager** prefix.

<!-- SCREENSHOT: Command Palette open with "BC Docker Manager" typed, showing the full list of commands.
     Save as: screenshots/command-palette.png -->
![Command Palette](screenshots/command-palette.png)

<details>
<summary><b>Full command reference (click to expand)</b></summary>

### Environment & Setup

| Command | Description |
|---------|-------------|
| Refresh | Refresh all containers, images, and volumes |
| Setup Everything | One-click environment setup (Hyper-V + Docker) |
| Enable Hyper-V & Windows Containers | Enable required Windows features |
| Install Docker Engine | Download and install the standalone engine |
| Start Docker Engine | Start the Docker Windows service |

### Artifacts

| Command | Description |
|---------|-------------|
| Open BC Artifacts Explorer | Browse BC artifacts from the Microsoft CDN |
| Test BC Artifacts CDN Connection | Verify CDN reachability |

### Container Lifecycle

| Command | Description |
|---------|-------------|
| Start Container | Start a stopped container |
| Stop Container | Stop a running container |
| Restart Container | Restart a running container |
| Remove Container | Delete a container |
| Export Container | Save container as a `.tar` image |
| Import Container | Load a `.tar` image file |
| Start All Stopped Containers | Bulk start |
| Stop All Running Containers | Bulk stop |
| Remove All Stopped Containers | Bulk remove |
| Toggle BC Filter | Show all or only BC containers and images |

### Connection & Networking

| Command | Description |
|---------|-------------|
| Open Web Client | Open Business Central in your browser |
| Open Container Terminal | PowerShell session inside the container |
| View Container Logs | Stream logs in real time |
| Copy Container IP | Copy the container's IP address |
| Setup Networking | Update hosts file + install SSL certificate |
| Update Hosts File | Map container hostname to its IP |
| Install SSL Certificate | Trust the container's self-signed certificate |

### AL Development

| Command | Description |
|---------|-------------|
| Generate AL Launch Configuration | Write `.vscode/launch.json` |
| Preview launch.json in New Tab | Open config for review |
| Copy launch.json to Clipboard | Copy config JSON |
| Compile AL App in Container | Compile using `alc.exe` inside the container |
| Publish AL App to Container | Publish > Sync > Install a `.app` file |

### BC Operations

| Command | Description |
|---------|-------------|
| Upload License File | Import a `.flf` or `.bclicense` file |
| Add BC User | Create a user with custom permissions |
| Add Test Users | Create 3 standard test users |
| Backup Database | Create a compressed `.bak` backup |
| Restore Database | Restore from a `.bak` file |
| Install Test Toolkit | Install test framework or full test toolkit |
| Edit NST Settings | View/edit NavServerTier configuration |
| View Event Log | Retrieve recent event log entries |
| Show Container Stats | Live resource monitoring |

### Container Profiles

| Command | Description |
|---------|-------------|
| Save Container Profile | Save container configuration |
| Load Container Profile | Create container from saved profile |
| Delete Container Profile | Remove a saved profile |

### Volumes

| Command | Description |
|---------|-------------|
| Create Volume | Create a new Docker volume |
| Remove Volume | Delete a Docker volume |
| Inspect Volume | View volume details |

### Images

| Command | Description |
|---------|-------------|
| Remove Image | Delete a local Docker image |
| Pre-Pull BC Image | Download the base BC image ahead of time |

</details>

---

## Extension Settings

Configure defaults under **Settings > Extensions > BC Docker Manager**:

| Setting | Default | Description |
|---------|---------|-------------|
| `bcDockerManager.defaultMemory` | `8G` | Memory limit for new containers (e.g. `4G`, `8G`, `16G`) |
| `bcDockerManager.defaultIsolation` | `hyperv` | Isolation mode: `hyperv` or `process` |
| `bcDockerManager.defaultAuth` | `UserPassword` | Authentication: `UserPassword`, `NavUserPassword`, or `Windows` |
| `bcDockerManager.defaultCountry` | `us` | Default country for artifact browsing (e.g. `us`, `w1`, `de`, `fr`) |
| `bcDockerManager.defaultDns` | `8.8.8.8` | DNS server for containers |
| `bcDockerManager.defaultArtifactType` | `sandbox` | Default artifact tab: `sandbox` or `onprem` |

---

## Known Issues

- **Container IPs change on restart** - use **Update Hosts File** (or **Setup Networking**) after restarting a container.
- **Docker Engine installation requires a reboot** to enable Windows Containers for the first time.
- **Docker Desktop conflict** - if Docker Desktop is installed, the standalone Docker Engine may conflict. The extension warns you if this is detected.

---

## Release Notes

### 1.0.0

Initial release:
- BC Artifacts Explorer with CDN browsing
- Native container creation via `docker run`
- Container lifecycle management (start, stop, restart, remove)
- AL launch.json generation, preview, and clipboard copy
- Environment setup wizard (Hyper-V, Windows Containers, Docker Engine)
- Hosts file and SSL certificate management
- User management and test user creation
- Database backup and restore
- Container profiles (save/load)
- Bulk operations (start all, stop all, remove all)
- Live container stats monitoring
- Volume management
- Container export/import
- AL app compilation and publishing
- Test toolkit installation
- NST settings editor
- Event log viewer

---

## Telemetry

This extension collects **anonymous** error and usage telemetry using the official [`@vscode/extension-telemetry`](https://www.npmjs.com/package/@vscode/extension-telemetry) package to help improve reliability. **No personal data is collected.** Telemetry respects your VS Code setting - disable it anytime:

> **Settings > Telemetry: Telemetry Level > off**

---

## License

[MIT](LICENSE)

---

<p align="center">
  <sub>Made with care for the Business Central developer community</sub>
</p>
