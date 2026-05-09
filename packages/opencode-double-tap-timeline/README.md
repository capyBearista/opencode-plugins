# opencode-double-tap-timeline

<p align="center">Double-tap Escape to open the timeline modal</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-double-tap-timeline"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-double-tap-timeline?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-double-tap-timeline"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-double-tap-timeline?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Why?

> Inspired by Claude Code's double-tap-to-invoke-`/rewind` feature. Instead of typing `/timeline` or reaching for the mouse, just double-tap Escape while in a session to open the timeline modal instantly.

## Philosophy: Extending OpenCode

OpenCode's TUI plugin system enables keyboard-driven UI extensions. This plugin hooks into the `app` slot to listen for Escape key presses globally, detects a double-tap within 800ms, and triggers the timeline command. It cleanly disposes of its timers on deactivation.

### Architecture

```text
src/index.ts
    └── tui hook
        ├── lifecycle.onDispose() — cleanup
        └── slots.register({ app() })
            └── useKeyboard() — Escape key listener
                └── double-tap detection (800ms window)
                    └── api.command.trigger("session.timeline")
```

## Features

- Global Escape key listener via the `app` slot — works regardless of which screen is active
- 800ms double-tap window, matching Claude Code's behavior
- Only triggers timeline when in a session with a valid session ID
- Single Escape still works normally (closes modals, cancels operations)
- Proper timer cleanup on plugin deactivation
- Skips trigger if a dialog is already open

## Install

Add the plugin to `tui.json` or `tui.jsonc`:

```json
{
  "plugin": ["@capybearista/opencode-double-tap-timeline@latest"]
}
```

## Usage

1. Open a session in OpenCode
2. Double-tap `Escape` quickly (within 800ms)
3. The timeline modal opens

**Note:** Hitting `Escape` two times in quick succession to interrupt a running prompt will also invoke the timeline modal. Hit `Escape` again to quickly exit.

## Configuration

This plugin requires no manual configuration.

## Troubleshooting

- If double-tap doesn't work, ensure you're in a session screen (not the home screen with the opencode logo)
- If a dialog is open, the timeline won't trigger. Close any open dialogs first

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on the double-tap timeline trigger.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](./LICENSE.txt)
