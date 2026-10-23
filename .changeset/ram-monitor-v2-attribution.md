---
"@capybearista/opencode-ram-monitor": minor
---

Rework the RAM monitor for OpenCode 2.x's shared background server. This minor release contains breaking changes; the 2.x line tracks OpenCode V2 rather than strict semver.

- **Breaking:** TUI-only. The server entry and its `/ram` command are removed; list the package only in `cli.json` (an `opencode.json` entry now fails with "Plugin entrypoint not found").
- **Breaking:** requires OpenCode 2.1+ (`@opencode/plugin >=2.1.0 <3`, OpenTUI `>=0.6.6`).
- **Breaking:** settings come only from the `cli.json` plugin entry's `options`; the `experimental.ramMonitor` config-file key is no longer read.
- The sidebar now shows the total plus "OpenCode X · Tools Y" (this TUI + the shared server vs. everything the server runs), replacing the This/All rows and session count that no longer reflect 2.x's process layout. The `/ram` modal shows the TUI, server, and orphaned terminal trees.
- New `layout: "minimal"` option renders a single borderless row.
- Invalid options now show a visible warning instead of failing silently.
