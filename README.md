# Agent Terminal IDE

> **Desktop Terminal IDE for launching, managing, and multiplexing multiple CLI coding agents (Claude Code, Codex CLI, Aider) in a high-performance grid layout.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Electron](https://img.shields.io/badge/Electron-31.2.0-blue)
![xterm.js](https://img.shields.io/badge/xterm.js-5.5.0-green)
![tmux](https://img.shields.io/badge/session--backend-tmux-orange)

---

##  Core Features

- **Dynamic Terminal Grid Layout**: Manage 4–6 terminal panes simultaneously arranged in **2x3** or **3x2** layout grids with real-time xterm.js reflowing on window and pane resize.
- **tmux Persistent Backend**: Every terminal session is backed by a detached tmux session (`tmux new-session -A -s ide-<uuid>`). If the app crashes or quits, your CLI agent tasks continue executing in the background and reattach seamlessly upon app restart with scrollback intact.
- **Orphan Session Detection & Recovery**: Automatically detects orphaned `ide-*` tmux sessions on app startup and offers a 1-click interface to reattach them into active grid panes.
- **CLI Agent Presets**: Pre-populated with presets for **Claude Code** (`claude`), **Codex CLI** (`codex`), **Aider AI** (`aider`), and interactive system shells (`bash`/`zsh`).
- **Broadcast Mode**: Toggle broadcast mode to mirror typing across all active terminal panes simultaneously — ideal for benchmarking agent responses on identical prompts.
- **Workspace Presets**: Save and load custom named workspace layouts (pane count, grid proportions, per-pane working directory, and agent assignments) to local storage.
- **Per-Pane Controls**: Custom header with editable label, interactive folder picker (`dialog.selectDirectory`), status indicator (Running, Idle, Exited, Detached), and restart/kill controls.
- **Global Keyboard Shortcuts**: Quick pane navigation (`Ctrl+1..6`), add pane (`Ctrl+Shift+N`), close pane (`Ctrl+Shift+W`), and toggle broadcast (`Ctrl+Shift+B`).

---

##  Prerequisites & Installation

### 1. Prerequisites
- **Node.js**: Version 18 or 20+
- **tmux**: Required for persistent session management.
  - **Linux (Mint/Ubuntu/Debian)**: `sudo apt update && sudo apt install -y tmux`
  - **macOS**: `brew install tmux`
- **Native Build Tools** (for `node-pty` compilation):
  - **Linux**: `sudo apt install -y build-essential python3`
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)

### macOS quick start

Install Homebrew first if it is not already present, then install the two system requirements:

```bash
xcode-select --install
brew install tmux
npm install
npm run rebuild
npm start
```

On Apple Silicon, run the install and build using the same architecture that will run the application (normally native `arm64` Terminal). Do not copy a `node_modules` directory built on an Intel Mac to Apple Silicon, or vice versa: rerun `npm install` and `npm run rebuild` instead.

### 2. Installation
```bash
# Clone the repository and navigate into directory
git clone https://github.com/your-org/agent-terminal-ide.git
cd agent-terminal-ide

# Install dependencies (automatically runs electron-rebuild via postinstall)
npm install
```

`npm install` may be configured to skip package install scripts in restricted CI environments. In that case, explicitly download Electron and rebuild the native PTY binding:

```bash
npm rebuild electron
npm run rebuild
```

---

##  Running the App

```bash
# Start Electron application locally
npm start
```

If `node-pty` requires re-compilation against your local Electron version, execute:
```bash
npm run rebuild
```

---

##  How tmux Session Persistence Works

Unlike standard terminal emulators that terminate shell processes when closed, **Agent Terminal IDE** leverages `tmux` as an IPC session daemon under the hood:

1. **Session Spawning**: When a pane is launched, `node-pty` spawns:
   ```bash
   tmux new-session -A -s ide-pane-1 -c /path/to/project "claude"
   ```
   The `-A` flag instructs tmux to **attach** to an existing session if one already exists, or create a new session if it doesn't.
2. **Crash & Quit Resilience**: When the Electron app quits, the terminal PTY handles disconnect, but the underlying `tmux` session and running agent processes continue executing in the background.
3. **Orphan Discovery & Reattachment**: On app launch, the main process executes `tmux list-sessions` to find any orphaned `ide-*` sessions. An interactive prompt allows you to reattach all active agent sessions with scrollback history preserved.
4. **Clean Teardown**: Clicking **Kill All Sessions** executes `tmux kill-session` across all `ide-*` instances to ensure zero lingering background processes when desired.

---

##  Adding Custom CLI Agent Presets

Preset options are configured via JSON and loaded dynamically. You can add new CLI agent tools (e.g. custom Python scripts, GPT-Engineer, or Aider variants) without editing application code.

### Option A: Edit Project Config (`config/agents.json`)
```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "command": "claude",
      "description": "Anthropic Claude Code CLI",
      "env": {}
    },
    {
      "id": "custom-agent",
      "name": "Custom Agent",
      "command": "python3 /path/to/agent.py --flag",
      "description": "Custom autonomous coding script",
      "env": {
        "API_KEY": "your-key-here"
      }
    }
  ]
}
```

### Option B: User Configuration Directory
Agent presets can also be saved in your user data directory (`<userData>/user_agents.json`), where they persist across app updates.

---

##  Keyboard Shortcuts Reference

| Shortcut | Action |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>1</kbd> .. <kbd>6</kbd> | Switch focus directly to Pane 1 to 6 |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> | Add new terminal pane to grid |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>W</kbd> | Close currently focused pane |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> | Toggle Broadcast Mode (keystroke multiplexing) |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> | Kill all active and orphaned tmux sessions |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> *(inside pane)* | Search text inside active terminal scrollback |

---

##  Building & Packaging for Linux

The project is pre-configured with `electron-builder` to package Linux distribution targets (**AppImage** and **.deb**).

```bash
# Build production AppImage and deb packages for Linux
npm run dist
```

The output installers will be generated in the `./dist/` directory:
- `dist/Agent Terminal IDE-1.0.0.AppImage`
- `dist/agent-terminal-ide_1.0.0_amd64.deb`

### macOS package

```bash
npm run dist:mac
```

This creates a `.dmg` and `.zip` in `dist/`. Local unsigned builds may trigger Gatekeeper when opened on another Mac; signing and notarization require your Apple Developer certificate and credentials and are intentionally not configured in this repository.

---

##  End-to-end smoke test

The smoke suite launches Electron through Playwright, verifies the initial four-pane grid, writes `echo hello-sandbox-test` through the real `node-pty` bridge, verifies that killing a pane kills its `ide-*` tmux session, then restarts Electron and reattaches a surviving session.

```bash
# Linux/headless CI
xvfb-run -a npm run test:smoke
```

On macOS, Xvfb is not used. Run the test from an interactive signed-in desktop session so Electron can connect to the native WindowServer:

```bash
npm run test:smoke
```

The test requires a functioning Electron binary, `tmux`, and Xvfb. It cleans up its `ide-*` tmux sessions on success. If it is interrupted, run `tmux list-sessions` and `tmux kill-session -t <name>` for any remaining test session.

---

## 📁 Project Structure

```
.
├── config/
│   └── agents.json          # CLI Agent presets configuration
├── main/
│   ├── index.js             # Electron main process entry point
│   ├── pty-manager.js       # node-pty + tmux session engine & orphan scanner
│   ├── agent-config.js      # Presets loader & storage sync
│   ├── workspace-store.js   # Local JSON storage for workspace presets
│   └── ipc-handlers.js      # Secure IPC endpoint registrations
├── preload/
│   └── index.js             # Preload script exposing contextBridge APIs
├── renderer/
│   ├── index.html           # Main UI structure & modals
│   ├── styles.css           # Modern dark-mode styling & grid CSS
│   ├── pane.js              # xterm.js pane component wrapper
│   ├── grid.js              # Grid layout manager (2x3 / 3x2)
│   ├── broadcast.js         # Broadcast mode input multiplexer
│   └── app.js               # Application state coordinator
├── package.json             # App manifest & electron-builder config
└── README.md                # Project documentation
```

---

##  License

Distributed under the MIT License. See `LICENSE` for details.
