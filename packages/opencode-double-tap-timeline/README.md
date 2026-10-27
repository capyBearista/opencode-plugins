# opencode-double-tap-timeline

<p align="center">Double-tap Escape to open the timeline modal</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-double-tap-timeline"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-double-tap-timeline?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-double-tap-timeline"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-double-tap-timeline?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

[![OpenCode Timeline window](../../.github/assets/timeline-TUI.png)](https://github.com/capyBearista/opencode-plugins/tree/main/packages/opencode-double-tap-timeline)

---

## Why?

> Inspired by Claude Code's double-tap-to-invoke-`/rewind` feature. Instead of typing `/timeline` or reaching for the mouse, just double-tap Escape while in a session to open the timeline modal instantly.

## Philosophy: Extending OpenCode

OpenCode is designed to be highly extensible. This plugin adds a keyboard shortcut: double-tap
`Escape` inside a session to open the timeline modal. It runs only in the TUI, detects a second
press within 800ms, leaves single presses untouched, and cleans up after itself.

### Architecture

```mermaid
flowchart LR
    Key[Escape key] --> Detect{Double-tap within 800ms?}
    Detect -->|Yes| Modal[Timeline modal opens]
    Detect -->|No| Native[Normal Escape behavior]
```

## Features

- **Double-tap window**: detects a second press within 800ms.
- **Single-press intact**: a single Escape still works normally (cancels running model turns, closes modals as usual).

## Install

### OpenCode V2

Requires OpenCode **2.0.0** or later. Add it under the `"plugins"` key in `cli.json`:

```json
{
  "plugins": ["@capybearista/opencode-double-tap-timeline@latest"]
}
```

TUI entry only, so `opencode.json(c)` needs no entry.

### OpenCode V1

Add it under the `"plugin"` key in `tui.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-double-tap-timeline@1.0.1"]
}
```

TUI entry only, so `opencode.json(c)` needs no entry.

See the [V1 plugin guide](../../docs/v1-plugins.md) for details.

### Uninstall

Remove the plugin from `"plugin(s)"` from the respective config files they were added to.

## Usage

1. Open a session in OpenCode
2. Double-tap `Escape` quickly (within 800ms)
3. The timeline modal opens

**Note:** Hitting `Escape` two times in quick succession to interrupt a running prompt will also invoke the timeline modal. Hit `Escape` again to quickly exit.

## Configuration

This plugin has no plugin-specific settings. Register it under the plural `plugins` key in the
V2 TUI `cli.json` profile as shown above. It is TUI-only and must not be added to the V2 server
`opencode.json` profile.

## Troubleshooting

- If double-tap doesn't work, ensure you're in a session screen (not the home screen with the opencode logo)
- If a dialog is open, the timeline won't trigger. Close any open dialogs first
- Holding `Escape` down can count as two presses and open the timeline; key repeat is not filtered

## Contributing

This package lives in the `opencode-plugins` monorepo. See the [contribution guidelines](../../CONTRIBUTING.md) for setup, the full check suite, and releases, and open or find an issue before a pull request.

From this directory, `bun test` runs the package tests. To try a change in your own OpenCode, see [Testing in OpenCode](../../CONTRIBUTING.md#testing-in-opencode).

## License

[MPL-2.0](./LICENSE.txt)
