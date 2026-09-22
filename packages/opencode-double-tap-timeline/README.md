# opencode-double-tap-timeline

<p align="center">Double-tap Escape to open the timeline modal</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-double-tap-timeline"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-double-tap-timeline?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Release status

Version **2.0.0** is published on the **`opencode2`** channel for OpenCode V2.
The V1 `latest` release remains frozen at **1.0.1**. The `@opencode/plugin` **2.0.0**
dependency identifies the SDK version, independently of this plugin's package version.

See the [V1 plugin guide](../../docs/v1-plugins.md) for the frozen V1 setup and the
[documentation index](../../docs/README.md) for repository-wide scope notes.

## Why?

> Inspired by Claude Code's double-tap-to-invoke-`/rewind` feature. Instead of typing `/timeline` or reaching for the mouse, just double-tap Escape while in a session to open the timeline modal instantly.

## Philosophy: Extending OpenCode V2

OpenCode V2's CLI plugin system enables keyboard-driven UI extensions. This plugin uses the public
`Plugin.define` API, claims the `app` slot, listens for Escape key presses, detects a double-tap
within 800ms, and dispatches the timeline command. It is TUI-only: the package exposes `./tui`,
has no bare or server entrypoint, and cleans up its timer and slot registration on deactivation.

### Architecture

```text
src/index.ts
    └── Plugin.define({ setup(context) })
        └── context.ui.slot({ append: "app", render })
            └── useKeyboard() — Escape key listener
                └── double-tap detection (800ms window)
                    └── context.keymap.dispatch("session.timeline")
```

## Features

- Escape key listener at the TUI root via the `app` slot
- 800ms double-tap window
- Only triggers timeline when in a session with a valid session ID
- Single Escape still works normally (closes modals, cancels operations)
- Proper timer and slot cleanup on plugin deactivation or unmount
- Skips trigger if a dialog is already open

## Install

Use `@opencode2` or the exact `@2.0.0` version for V2. `@latest` identifies the frozen V1
line, and `@v2` is a semver range rather than a channel. The local recipe below is for
development in an isolated V2 profile.

### Local V2 directory

Build before checking a local directory or a packaged artifact. From this package directory, run
`bun run build`; from the monorepo root, the canonical command is `bun run build`. Register the
package **directory**, not `tui.js` or another single file, in the isolated V2 `cli.json` profile:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/opencode-plugins/packages/opencode-double-tap-timeline"]
}
```

The package root includes `tui.js`, a local-directory entrypoint that re-exports the built plugin.
The wrapper imports `dist/index.js`, so `dist` must exist before loading the directory. Package
`exports` alone are not sufficient for an unnamed filesystem directory. Relative `./` and `../`
entries resolve against the directory containing `cli.json`; `file://` and absolute paths also work.

This package is TUI-only. Configure it in V2 `cli.json`, not in `opencode.json`: the latter is the
server profile, while this package intentionally has no server entrypoint. The named `./tui` export
resolves to `dist/index.js`; it does not replace the root `tui.js` wrapper for local directory
resolution.

### Registry installation

The V2 TUI profile `~/.config/opencode/cli.json` may contain the timeline under the
plural `plugins` key:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@capybearista/opencode-double-tap-timeline@opencode2"]
}
```

Use `@2.0.0` instead of `@opencode2` for an exact pin. The V2 command definitions are separate
from the V1 CLI:

```bash
opencode2 plugin add @capybearista/opencode-double-tap-timeline@opencode2
opencode2 plugin check
```

The V2 `plugin add` command routes this TUI-only package to `cli.json` automatically. Do not add
it manually to the server `opencode.json`. Keep V2 configuration separate from V1's `tui.json`
and `plugin` list. `OPENCODE_CONFIG_DIR` selects a separate configuration root; a fully isolated
trial also needs separate home, data, state, and cache locations. The plugin does not migrate them.

### Updates

Restart is not an upgrade. For a mutable V2 registry target, `check` only reports whether a newer
generation is available. Run `opencode2 plugin update` with the configured target as its argument
to update that package; omitting the target updates all configured mutable targets. A pinned exact
version reports no update. The `opencode2` channel identifies host compatibility, not package major.
No updater interval or automatic application of a mutable tag is promised. Do not delete the npm
cache directory. A local-directory entry has no registry version to update: rebuild the package,
then restart or otherwise reload the TUI. No general live-hot-reload guarantee is made.

The frozen V1 release uses the V1 host and `opencode plugin <module>` with an explicit `@1.0.1`
spec. V1 cached loads remain cached; do not use the V2 `add`, `check`, or `update` commands on a
V1 host.

## Usage

1. Open a session in OpenCode
2. Double-tap `Escape` quickly (within 800ms)
3. The timeline modal opens

**Note:** Hitting `Escape` two times in quick succession to interrupt a running prompt will also invoke the timeline modal. Hit `Escape` again to quickly exit.

## V2 verification and limits

Automated unit tests cover the detector, and the scoped build/static checks include the real
local-directory resolver regression without starting a provider session. In one isolated V2 TUI
host, human verification confirmed that double-Escape opens the timeline, a single Escape keeps
native behavior, the modal-close path does not seed an unintended gesture, and the timeline action
executes.

The detector uses an 800ms window and the exact-boundary test advances the fake clock to 800ms,
runs the scheduled expiry, and then delivers the key. That is the chosen timer-first ordering; no
grace window is added. The guard is session-only and modal-aware. Key-repeat filtering is not added,
so holding Escape can count as multiple presses. Host reload timing remains host-dependent.

## Configuration

This plugin has no plugin-specific settings. Register it under the plural `plugins` key in the
V2 TUI `cli.json` profile as shown above. It is TUI-only and must not be added to the V2 server
`opencode.json` profile.

## Troubleshooting

- If double-tap doesn't work, ensure you're in a session screen (not the home screen with the opencode logo)
- If a dialog is open, the timeline won't trigger. Close any open dialogs first

## Contributing

This package lives in the `opencode-plugins` monorepo.

See the [contribution guidelines](../../CONTRIBUTING.md) before opening a pull request.

- From the monorepo root, run `bun run build` before artifact checks, then `bun run typecheck`,
  `bun run lint`, and the canonical `bun run test` Turbo pipeline. Do not use bare root `bun test`
  as the workspace check.
- For a focused run, `bun test` is supported from this package directory; its tests include the
  real local-directory resolver regression.
- `bun run check` writes Biome changes; use it only when formatting changes are intended.
- Keep the plugin focused on the double-tap timeline trigger.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](./LICENSE.txt)
