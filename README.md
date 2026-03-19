# BC Docker Manager

A lightweight control center for Business Central Docker development inside VS Code. Manage containers, browse artifacts, set up your environment, and generate AL configurations, without BcContainerHelper or Docker Desktop.

## Features

### BC Artifacts Explorer
Browse available Business Central artifacts from the Microsoft CDN. Filter by type (Sandbox / OnPrem), country, and major version. Create containers with one click.

### Container Management
- **Start / Stop / Restart / Remove** containers from the sidebar
- **Open Web Client**: opens the BC web client in your browser
- **Open Terminal**: PowerShell session inside the container
- **View Logs**: stream container logs in real time

### Environment Setup
Guided wizard to get your machine ready for BC containers:
1. Enable Hyper-V & Windows Containers
2. Install Docker Engine (standalone, no Docker Desktop needed)

### AL Development
- **Generate launch.json**: creates the AL Language extension config to connect to your container
- **Preview launch.json**: opens the config in a new editor tab for review
- **Copy launch.json**: copies the config to your clipboard

### Networking
- **Update Hosts File**: maps the container hostname to its IP address
- **Install SSL Certificate**: trusts the container's self-signed certificate

## Requirements

- **Windows 10/11** or **Windows Server 2019+**
- **Hyper-V** enabled
- **Docker Engine** (standalone Windows service, Docker Desktop is optional)

## Getting Started

1. Install the extension
2. Open the **BC Docker Manager** sidebar (container icon in the activity bar)
3. Check the **Environment** panel. Click **Setup Everything** if needed
4. Open the **BC Artifacts** panel to browse and create containers
5. Right-click containers for actions (web client, terminal, launch.json, etc.)

## Commands

All commands are available from the Command Palette (`Ctrl+Shift+P`) under the **BC Docker Manager** category:

| Command | Description |
|---------|-------------|
| Refresh | Refresh containers and images |
| Open BC Artifacts Explorer | Browse BC artifacts from the CDN |
| Setup Everything | One-click environment setup |
| Start / Stop / Restart Container | Container lifecycle |
| Remove Container / Image | Clean up resources |
| Open Web Client | Open BC in the browser |
| Open Container Terminal | PowerShell inside the container |
| View Container Logs | Stream logs in real time |
| Generate AL Launch Configuration | Write launch.json to your project |
| Preview launch.json in New Tab | Open config for review |
| Copy launch.json to Clipboard | Quick copy for pasting |
| Update Hosts File | Map container hostname to IP |
| Install SSL Certificate | Trust the container's certificate |
| Install Docker Engine | Standalone engine installer |
| Toggle BC Filter | Show all or only BC containers |

## Extension Settings

This extension does not add any VS Code settings at this time.

## Known Issues

- Container IP addresses change on restart. Use **Update Hosts File** after restarting a container.
- Docker Engine installation requires a system restart to enable Windows Containers.

## Release Notes

### 1.0.0

Initial release:
- BC Artifacts Explorer with CDN browsing
- Native container creation via `docker run`
- Container lifecycle management
- AL launch.json generation
- Environment setup wizard
- Hosts file and SSL certificate management

## License

MIT

## Telemetry

This extension collects anonymous error and usage telemetry using the official [`@vscode/extension-telemetry`](https://www.npmjs.com/package/@vscode/extension-telemetry) package to help improve reliability. No personal data is collected. Telemetry respects your VS Code telemetry setting — disable it anytime via **Settings → Telemetry: Telemetry Level → off**.
