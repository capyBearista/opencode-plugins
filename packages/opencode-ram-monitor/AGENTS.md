# opencode-ram-monitor — OpenCode plugin

**Technology**: TypeScript / OpenCode Plugin / OpenTUI
**Entry Points**: `src/server.ts`, `src/sidebar.tsx`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: V1-only (`releaseClass: v1`, `latest` channel) — no V2 port in this release.

This package is a dual server/TUI plugin. The server side registers `/ram` and injects process-tree output into the session. The TUI side renders a live sidebar widget with lightweight RAM polling.

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
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative.

## Architecture

### Directory Structure
`src/
├── index.ts            # Server barrel export
├── server.ts           # Registers /ram and injects command output
├── sidebar.tsx         # Sidebar widget and polling lifecycle
├── memory.ts           # Heavy/lightweight RAM collection helpers
├── snapshot.ts         # Cache for repeated process snapshots
├── sidebar-config.ts   # Widget config loading and validation
└── debug.ts            # File-backed debug logging
`

### Core (understand these first)
- `src/server.ts` — registers the `/ram` command and short-circuits normal command execution after injecting raw output back into the session
- `src/sidebar.tsx` — TUI widget with recursive `setTimeout` polling, theme-aware rendering, and cleanup on unmount
- `src/memory.ts` — process inspection logic; this is where OS-specific behavior and performance tradeoffs live
- `src/sidebar-config.ts` — config discovery and fallback behavior for widget refresh intervals

### Build
This package is a split-output plugin:
- `tsc --project tsconfig.build.json --emitDeclarationOnly` emits type declarations
- `bun build` compiles each runtime entrypoint separately for server and TUI use
- `package.json` publishes separate `./server` and `./tui` exports and declares `oc-plugin: ["server", "tui"]`

### Gotchas
- Do not introduce top-level async work in `src/sidebar.tsx`; keep polling startup inside `onMount`.
- Use recursive `setTimeout`, not `setInterval`, so RAM probes cannot overlap.
- Any change to RAM collection should be validated on the target OS pattern documented in `docs/opencode-plugin-ipc-and-os-patterns.md`.
- Command injection failures must fail clearly; `/ram` should not silently swallow output or leave the session hanging.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Runtime smoke: verify both the `./server` and `./tui` exports load in OpenCode and that the sidebar widget still renders without IPC startup regressions

## License

MPL-2.0
