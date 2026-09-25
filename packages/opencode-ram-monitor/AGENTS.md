# opencode-ram-monitor — OpenCode plugin

**Technology**: TypeScript / OpenCode Plugin / OpenTUI
**Entry Points**: `src/server.ts`, `src/tui.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: V2 (`@opencode/plugin` 2.x) — single package, dual `server.js`/`tui.js` entries.

This package is a dual server/TUI plugin. The TUI side is primary: sidebar widget with lightweight RAM polling, plus a `/ram` modal (also opened by clicking the widget). The server side is secondary: it registers `/ram` for non-TUI sessions by injecting process-tree output into the session.

## Quick Reference

| Script              | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `bun run check`     | Lint and format (Biome)                   |
| `bun run lint`      | Validate without modifying                |
| `bun run ci`        | CI mode (non-mutating)                    |
| `bun run typecheck` | Type check                                |
| `bun test`          | Run tests                                 |
| `bun run build`     | Build server/TUI outputs and declarations |

## Development Commands

### This Package
`# From package directory
bun run build
bun test
bun run typecheck
bun run lint
`

### From Root
`bun --filter @capybearista/opencode-ram-monitor build
bun --filter @capybearista/opencode-ram-monitor test
`

### Pre-PR Checklist
`bun --filter @capybearista/opencode-ram-monitor typecheck && \
bun --filter @capybearista/opencode-ram-monitor lint && \
bun --filter @capybearista/opencode-ram-monitor test
`

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use the debug helpers in `src/debug.ts` so failures can be correlated without polluting chat output.
- Colocate tests with source files (`src/ram-monitor.test.ts`).
- Imports: builtins first, then external, then relative.

## Architecture

### Directory Structure
`src/
├── server.ts           # V2 server entry: registers /ram for non-TUI sessions
├── tui.ts              # V2 TUI entry: sidebar widget, /ram modal, keymap command
├── theme.ts            # V2 theme-token adapter for widget and modal
├── memory.ts           # Heavy/lightweight RAM collection helpers
├── snapshot.ts         # Cache for repeated process snapshots
├── sidebar-config.ts   # Widget config loading and validation
└── debug.ts            # File-backed debug logging
`

### Core (understand these first)
- `src/tui.ts` — sidebar widget with recursive `setTimeout` polling, theme-aware rendering, and cleanup on unmount; opens the RAM modal on `/ram` and on widget click
- `src/server.ts` — registers the `/ram` command via `command.transform` and injects output for sessions without a TUI
- `src/memory.ts` — process inspection logic; this is where OS-specific behavior and performance tradeoffs live
- `src/sidebar-config.ts` — plugin `options` first, then config-file discovery with fallback behavior for widget refresh intervals

### Build
This package is a split-output plugin:
- `tsc --project tsconfig.build.json --emitDeclarationOnly` emits type declarations
- `bun build` compiles each runtime entrypoint separately for server and TUI use
- `package.json` publishes separate `./server` and `./tui` exports with package-root `server.js`/`tui.js` wrappers (no `oc-plugin` key)

### Gotchas
- Do not introduce top-level async work in `src/tui.ts`; keep polling startup inside `onMount`.
- Use recursive `setTimeout`, not `setInterval`, so RAM probes cannot overlap.
- Any change to RAM collection should be validated on the target OS pattern documented in `docs/opencode-plugin-ipc-and-os-patterns.md`.
- The modal opens with `dialog.clear()`, then `show()`, then `set({ size: "xlarge" })` — order matters because `show()` resets the size.
- The `/ram` keymap layer must live inside the `app` slot render (host ownership rule); keep the dedupe guard.
- Server injection failures must fail clearly; `/ram` should not silently swallow output or leave the session hanging.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Runtime smoke: `bun run smoke` verifies both the `./server` and `./tui` built exports load and register; also verify the sidebar widget renders without IPC startup regressions

## License

MPL-2.0
