# opencode-ram-monitor

<p align="center">Zero-dependency RAM monitoring for OpenCode sessions</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-ram-monitor"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-ram-monitor?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-ram-monitor"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-ram-monitor?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6
  " /></a>
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
- **`/ram` Command**: Intercepts the `/ram` command to provide a detailed, heavy process-tree breakdown of the current session right in the chat.
- **Configurable**: Polling intervals can be customized via `.opencode/opencode.json`.

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

To get a detailed heavy process tree of your current session's memory usage, simply type `/ram` in your OpenCode chat.

## Configuration

Add the following to your `.opencode/opencode.json` to configure the plugin:

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

- **Widget missing from sidebar**: Ensure both the server and TUI plugins are registered in `opencode.json` and `tui.json` respectively. If `refreshIntervalMs` is configured, ensure your `opencode.json` is valid, as comments can cause the config reader to fail or fallback.
- **Active count seems off**: The plugin tokenizes command lines to find active `opencode` processes. Deeply nested wrappers or complex invocation aliases might not be matched.
- **Total RAM shows `0`**: If sampling fails completely (e.g. `ps` is missing), the plugin falls back to using `process.memoryUsage().rss` of the current process. Ensure standard process utilities are available.

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on RAM monitoring logic.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](LICENSE)