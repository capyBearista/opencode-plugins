# @capybearista/opencode-double-tap-timeline

## 2.0.0

### Major Changes

- Switch this package to the OpenCode V2 TUI host SDK. This is a breaking V2-only release and does not change the frozen V1 `latest` line.

  Register the package directory in V2 `cli.json`; the package root `tui.js` is the local TUI entrypoint. The plugin listens from the TUI root and dispatches `session.timeline` after two Escape presses within 800ms during a session. It does not trigger while a modal is open and keeps the gesture tied to its originating session. Deactivation cancels timers, disables existing detectors, and unregisters the slot; keyboard listeners are removed on unmount.

  V2 releases use the opt-in `opencode2` channel. The V1 `latest` line remains frozen at 1.0.1.

## 1.0.1

### Patch Changes

- 9a98d68: Fix for OpenCode v1.14.42 keymap API change

## 1.0.0

### Major Changes

- c2f6f5f: Inspired by Claude Code's double-tap-to-invoke-/rewind feature. Instead of typing /timeline or reaching for the mouse, just double-tap Escape while in a session to open the timeline modal instantly.
