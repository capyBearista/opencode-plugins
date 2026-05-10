# opencode-ram-monitor

<p align="center">Zero-dependency RAM monitoring for OpenCode sessions</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-ram-monitor"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-ram-monitor?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-ram-monitor"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-ram-monitor?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Why?

> This plugin gives developers real-time, zero-dependency insights into the memory usage of all their active OpenCode sessions and child processes.

## Philosophy: Extending OpenCode

OpenCode is designed to be highly extensible. This plugin hooks into the OpenCode lifecycle to provide additional functionality seamlessly into your workflows. By intercepting host commands and injecting UI components into the sidebar, we demonstrate the power of OpenCode's dual plugin architecture (server and TUI). It operates entirely locally and gracefully degrades if process sampling fails.

### Architecture

```text
Host Architecture
├── Server Plugin (src/server.ts)
│   ├── command.execute.before hook
│   │   └── Intercepts `/ram`
│   └── Injects raw heavy process tree into the active session
│
└── TUI Plugin (src/sidebar.tsx)
    ├── sidebar_content slot
    │   └── Renders `RamWidget` in the TUI sidebar
    ├── Poller
    │   └── Calls `getLightweightRam()` at `refreshIntervalMs`
    └── Process Sampler (src/memory.ts)
        └── Discovers `opencode` PIDs via `ps`/`wmic` to get total session count
```

## Features

- **Real-time Sidebar Widget**: View your current and total RAM usage natively in the OpenCode TUI sidebar.
- **Active Session Tracking**: Automatically discovers all running OpenCode sessions and aggregates their RAM.
- **Cross-Platform**: Uses native commands (`ps` on Unix, `wmic` on Windows) for lightweight zero-dependency metrics.
- **`/ram` Command**: Intercepts the `/ram` command to provide a detailed, heavy process-tree breakdown across all active OpenCode sessions right in the chat.
- **Configurable**: Polling intervals can be customized via `opencode.json`, `opencode.jsonc`, `tui.json`, `tui.jsonc`, and their `.opencode/` variants.

## Install

Add the plugin to `opencode.json` or `opencode.jsonc`:
```json
{
  "plugin": ["@capybearista/opencode-ram-monitor"]
}
```

Also, add the plugin to `tui.json` or `tui.jsonc`:
```json
{
  "plugin": ["@capybearista/opencode-ram-monitor"]
}
```

## Usage

Once installed, the RAM monitor will automatically appear in your OpenCode TUI sidebar, polling your system to display the memory usage of your current session and the aggregate total across all active sessions.

To get a detailed heavy process tree of memory usage across all currently active OpenCode sessions, type `/ram` in your OpenCode chat.

## Configuration

Add the following to any supported OpenCode config file to configure the plugin:

- `opencode.json`
- `opencode.jsonc`
- `.opencode/opencode.json`
- `.opencode/opencode.jsonc`
- `tui.json`
- `tui.jsonc`
- `.opencode/tui.json`
- `.opencode/tui.jsonc`

When multiple files define `experimental.ramMonitor.refreshIntervalMs`, the plugin applies them in this order and lets later files win:

1. `opencode.json`
2. `opencode.jsonc`
3. `.opencode/opencode.json`
4. `.opencode/opencode.jsonc`
5. `tui.json`
6. `tui.jsonc`
7. `.opencode/tui.json`
8. `.opencode/tui.jsonc`

JSONC comments and trailing commas are supported.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `experimental.ramMonitor.refreshIntervalMs` | `number` | `5000` | Polling interval for the sidebar widget in milliseconds. Clamped between `1000` and `60000`. |

Example:
```json
{
  "experimental": {
    "ramMonitor": {
      "refreshIntervalMs": 2000
    }
  }
}
```

## Troubleshooting

- **Widget missing from sidebar**: Ensure both the server and TUI plugins are registered in your OpenCode server and TUI config files.
- **Refresh interval did not change**: The widget reads `experimental.ramMonitor.refreshIntervalMs` from all supported `opencode.*` and `tui.*` config files, including `.opencode/` variants. Later files override earlier ones.
- **Config warning shown in the sidebar**: A supported config file could not be parsed, so the widget is using the last valid value it found or the default `5000ms` interval.
- **Active count seems off**: The plugin tokenizes command lines to find active `opencode` processes. Deeply nested wrappers or complex invocation aliases might not be matched.
- **Total RAM shows `0`**: If sampling fails completely (e.g. `ps` is missing), the plugin falls back to using `process.memoryUsage().rss` of the current process. Ensure standard process utilities are available.

## Debug Logging

Debug logging is disabled by default. To enable diagnostic logs during development:

```bash
OPENCODE_RAM_MONITOR_DEBUG=1 opencode
```

When enabled, the plugin appends structured JSON log lines to `.opencode-ram-monitor.log` in the current working directory.

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on RAM monitoring logic.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](./LICENSE.txt)
