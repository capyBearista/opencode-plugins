# opencode-ram-monitor

<p align="center">Zero-dependency RAM monitoring for OpenCode sessions</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-ram-monitor"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-ram-monitor?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-ram-monitor"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-ram-monitor?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

[![OpenCode Ram Monitor sidebar](../../.github/assets/ram-monitor-sidebar.webp)](https://github.com/capyBearista/opencode-plugins/tree/main/packages/opencode-ram-monitor)

---

## Why?

> This plugin gives developers real-time, zero-dependency insight into how much memory OpenCode is using. The sidebar shows the total, split into OpenCode itself (this TUI and the shared server) and the tools the server runs (MCP servers, language servers, shell commands, terminals). The `/ram` command (and clicking the widget) opens the full process tree in a pop-up.

## Philosophy: Extending OpenCode

OpenCode V2 runs one shared background server per user. Every TUI connects to it, and the server owns sessions and tool execution. Memory is shared rather than per-session, so this plugin reports it by role:

- **OpenCode**: this TUI (plus its own helper processes) and the server it is connected to.
- **Tools**: everything the server runs, plus terminal panes (`opencode-pty`) that outlived a server restart.

The plugin asks OpenCode which server this TUI talks to and only trusts that answer when the local process table confirms it. It runs locally, needs no dependencies, and falls back to this TUI's own memory if the server or the process list cannot be read.

### Architecture

```mermaid
flowchart TB
  TUI["TUI plugin"] --> Widget["Sidebar widget (full or minimal)"]
  TUI --> Modal["/ram modal"]
  Widget --> Inspect["Server pid (client.server.info) + one process snapshot per poll"]
  Modal --> Inspect
  Inspect --> Roles["OpenCode = TUI + server · Tools = server's subtree + orphaned terminals"]
```

## Features

- **Real-time sidebar widget**: shows the total, then OpenCode vs. tools, in a compact card.
- **Minimal layout**: one borderless line, `RAM ● 4.88 GB (tools 3.39 GB)`, for a quieter sidebar.
- **`/ram` command**: opens the TUI, server, and terminal process trees in a pop-up (also opened by clicking the widget).
- **Cross-platform**: uses native commands (`ps` on Unix, `wmic` on Windows) for lightweight zero-dependency metrics.
- **Configurable**: layout and polling interval via plugin `options`, applied live when `cli.json` changes.

## Install

### OpenCode V2

Requires OpenCode **2.1.0** or later. This is a TUI-only plugin: add it under the `"plugins"` key in `cli.json` (your global OpenCode config directory, usually `~/.config/opencode/cli.json`):

```json
{
  "plugins": ["@capybearista/opencode-ram-monitor@latest"]
}
```

> [!IMPORTANT]
> This plugin is TUI-only, so it belongs in `cli.json`.

#### Upgrading from 2.0.x

- Move `experimental.ramMonitor.refreshIntervalMs` into the plugin entry's `options` as `refreshIntervalMs` (see [Configuration](#configuration)).
- Sessions without a TUI no longer have `/ram`; it remains in the TUI.
- The "This" / "All" rows and the session count are gone. The widget now shows OpenCode vs. Tools (see [Usage](#usage)).

### OpenCode V1

Add it under the `"plugin"` key in `opencode.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-ram-monitor@1.1.0"]
}
```

**AND**

Add it under the `"plugin"` key in `tui.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-ram-monitor@1.1.0"]
}
```

On V1 (1.1.0), set the polling interval with `experimental.ramMonitor.refreshIntervalMs` (default `5000`, clamped between `1000` and `60000`) in `opencode.json(c)` or `tui.json(c)`, globally or under `.opencode/`.

See the [V1 plugin guide](../../docs/v1-plugins.md) for details.

### Uninstall

Remove the plugin from `"plugin(s)"` from the respective config files they were added to. 

## Usage

Once installed, the RAM monitor appears in the TUI sidebar of every session:

```text
╭───────────────────────────────────╮
│ RAM Usage ●              4.88 GB  │
│ OpenCode 1.49 GB · Tools 3.39 GB  │
╰───────────────────────────────────╯
```

- **Header**: total memory; the dot flips on every refresh.
- **OpenCode**: this TUI plus the shared server.
- **Tools**: MCP servers, language servers, shell commands, and terminal panes the server runs.

Type `/ram` or click the widget for the full process tree; `esc` closes it.

## Configuration

Pass options in the plugin's `cli.json` entry, using the object form:

```json
{
  "plugins": [
    {
      "package": "@capybearista/opencode-ram-monitor@latest",
      "options": { "layout": "minimal", "refreshIntervalMs": 2000 }
    }
  ]
}
```

> [!WARNING]
> Use the object form above. The V1 tuple form (`["@capybearista/opencode-ram-monitor", { ... }]`) is not valid in V2's `cli.json`, and one invalid entry makes OpenCode ignore the whole file, including your theme, keybinds, and every other plugin.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `layout` | `"full"` \| `"minimal"` | `"full"` | `full` is the bordered two-row card. `minimal` is one borderless line: `RAM ● 4.88 GB (tools 3.39 GB)`. |
| `refreshIntervalMs` | `number` | `5000` | Polling interval in milliseconds. Numeric strings are accepted. Values are clamped between `1000` and `60000`. |

Invalid values fall back to the default and show a warning: as footer text in the full layout, as a warning color in the minimal layout, and listed near the top of the `/ram` pop-up.

The minimal layout has no room for text, so the "server not visible" and "process list unavailable" notices (see [Troubleshooting](#troubleshooting)) also appear only as a warning color there. The full layout and the `/ram` pop-up show them as text.

OpenCode re-applies a plugin's options when `cli.json` changes, so edits take effect without a restart. Options are only read from `cli.json`; the 2.0.x `experimental.ramMonitor` config-file key is no longer supported.

## Troubleshooting

- **Widget missing from sidebar**: Check the entry is in the global `cli.json` `plugins` list. OpenCode does not read project-level `cli.json` files. The sidebar also hides for subagent sessions and on narrow terminals (toggle it with the `session.sidebar.toggle` command).
- **"server not visible"**: The plugin could not confirm which server this TUI uses, so it shows only this TUI and its helper processes; terminal panes are left out too. This is expected when the TUI is connected with `--server` to a server on another machine, because that server's processes are not in the local process list.
- **"process list unavailable"**: `ps` (or `wmic` on Windows) could not be run, so only this TUI's own memory is shown. Ensure standard process utilities are installed.
- **Windows shows only the TUI's memory**: On Windows the plugin reads the process list with `wmic`, which Microsoft has deprecated and newer Windows 11 releases no longer install by default. Without it, the widget falls back to this TUI's own memory with the "process list unavailable" notice. Where Windows still offers WMIC as an optional feature, enabling it restores the full numbers. WSL is unaffected; it uses the Linux path.
- **Other OpenCode windows are not counted**: Each TUI counts itself plus the shared server and its tools. Other TUI windows connected to the same server are not included, unless one runs inside an OpenCode terminal pane, where it counts as a tool.
- **Terminals missing after a server restart**: Terminal panes that outlive a server restart are matched by their runtime directory under your home directory. If `XDG_STATE_HOME` points outside your home, they are not counted.
- **Tools look high**: Tools include everything the server starts: MCP servers, language servers, shell commands, and terminal panes. Open `/ram` to see which processes are responsible.
- **Options did not apply**: Make sure the entry uses the object form (see [Configuration](#configuration)) and lives in the global `cli.json`.
- **Reporting a bug**: Start OpenCode with `OPENCODE_RAM_MONITOR_DEBUG=1 opencode` to have the plugin append JSON log lines to `.opencode-ram-monitor.log` in the current directory, and attach that file. Logging is off by default.

## Contributing

This package lives in the `opencode-plugins` monorepo. See the [contribution guidelines](../../CONTRIBUTING.md) for setup, the full check suite, and releases, and open or find an issue before a pull request.

From this directory, `bun test` runs the package tests and `bun run smoke` builds the package and loads it through OpenCode's own entry resolver. To try a change in your own OpenCode, see [Testing in OpenCode](../../CONTRIBUTING.md#testing-in-opencode).

## License

[MPL-2.0](./LICENSE.txt)
