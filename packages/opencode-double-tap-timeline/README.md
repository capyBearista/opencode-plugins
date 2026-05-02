# OpenCode Double-Tap Timeline

Double-tap `Escape` to open the `/timeline` modal, inspired by Claude Code's double-tap-to-invoke-`/rewind` feature.

## Installation

Simply add to your `tui.json`:

```json
{
  "plugin": ["@capybearista/opencode-double-tap-timeline"]
}
```

## Usage

1. Open a session in OpenCode
2. Double-tap `Escape` quickly (within 800ms)
3. The timeline modal opens
4. Profit

## How it works

- **Global listener**: Uses the `app` slot to always be active regardless of which screen you're on
- **Double-tap detection**: 800ms window, matching Claude Code's behavior
- **Smart triggers**: Only opens timeline when in a session with a valid session ID
- **Graceful fallback**: Single `Escape` works normally (closes modals, cancels operations)
- **Cleanup**: Properly disposes of timers when the plugin is deactivated

## Requirements

- **OpenCode** (tested on 1.14.24)
- **@opentui/solid** (installed automatically as peer dependency)
- **@opentui/core** (installed automatically as peer dependency)

## Notes

Hitting `Escape` two times in quick succession to interrupt your running prompt will *also* invoke the timeline modal. Just hit `Escape` again to quickly exit out of the resulting modal.

## License

MPL 2.0
