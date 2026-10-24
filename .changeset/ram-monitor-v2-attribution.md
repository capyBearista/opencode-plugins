---
"@capybearista/opencode-ram-monitor": minor
---

Rework the RAM monitor for OpenCode 2.x's shared background server. This minor release contains breaking changes; the 2.x line tracks OpenCode V2 rather than strict semver.

- **Breaking:** TUI-only. The server entry is removed, including the server-side `/ram` that injected the process tree into sessions without a TUI; `/ram` remains in the TUI. List the package only in `cli.json`, and remove any old `opencode.json` entry.
- **Breaking:** requires OpenCode 2.1+ (`@opencode/plugin >=2.1.0 <3`, OpenTUI `>=0.6.6`).
- **Breaking:** settings come only from the `cli.json` plugin entry's `options`; the `experimental.ramMonitor` config-file key is no longer read.
- The sidebar now shows the total plus "OpenCode X · Tools Y" (this TUI + the shared server vs. everything the server runs), replacing the This/All rows and session count that no longer reflect 2.x's process layout. The `/ram` modal shows the TUI, server, and orphaned terminal trees.
- New `layout: "minimal"` option renders a single borderless row.
- Invalid options now fall back to defaults with a visible warning (footer text in the full layout, warning color in the minimal layout, and listed in the `/ram` modal) instead of failing silently.
