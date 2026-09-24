# opencode-double-tap-timeline — OpenCode plugin

**Technology**: TypeScript / OpenCode plugin (V2 TUI API: `@opencode/plugin/tui`)
**Entry Point**: `src/index.ts` — built to `dist/index.js`, surfaced by the named `./tui` export and the package-root `tui.js` re-export
**Version / channel**: V2-only **2.0.0** (`opencode2` channel); the V1 `latest` line stays frozen at **1.0.1**
**Registration**: TUI `cli.json` profile under the plural `plugins` key; never the V2 server `opencode.json`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)

## Quick Reference

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `bun run check`     | Lint and format (Biome)    |
| `bun run lint`      | Validate without modifying |
| `bun run ci`        | CI mode (non-mutating)     |
| `bun run typecheck` | Type check                 |
| `bun test`          | Run tests                  |
| `bun run build`     | Compile (tsc d.ts + Bun.build) |

## Development Commands

### This Package
`# From package directory
bun run build
bun test
bun run typecheck
bun run lint
`

### From Root
`bun --filter @capybearista/opencode-double-tap-timeline build
bun --filter @capybearista/opencode-double-tap-timeline test
`

### Pre-PR Checklist
`bun --filter @capybearista/opencode-double-tap-timeline typecheck && \
bun --filter @capybearista/opencode-double-tap-timeline lint && \
bun --filter @capybearista/opencode-double-tap-timeline test
`

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use structured approaches for logging/debugging.
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative.

## Architecture

### Directory Structure
`src/
├── index.ts           # Plugin entry point (TUI): Plugin.define, app slot, detector wiring, dispose
├── escape-detector.ts # Core logic: createEscapeDetector — 800ms double-tap, modal/route guards, dispose
├── index.test.ts      # Basic export tests
`
Package root:
- `tui.js` — local-directory entrypoint that re-exports `./dist/index.js` (built artifact must exist)
- `bunfig.toml` — Bun preload for `@opentui/solid` JSX transformation at runtime

### Core (understand these first)
- `src/escape-detector.ts` — core state machine: `createEscapeDetector` tracks the 800ms double-tap window, applies modal and session-route guards, and exposes `handle`/`dispose` with explicit timer cleanup
- `src/index.ts` — TUI plugin: registers global Escape key listener via `context.ui.slot({ append: "app" })`, calls `context.keymap.dispatch("session.timeline")` on double-tap, disposes detectors and slot registration on teardown
- `tui.js` — root wrapper so a local package directory loads; the named `./tui` export alone does not resolve for an unnamed filesystem directory

### Build
TUI plugins use a split build:
- `tsc --emitDeclarationOnly` emits `.d.ts` type declarations (no JS, avoids raw JSX leak from `jsx: preserve`)
- `bun build` compiles the actual runtime JavaScript with proper JSX handling

### Gotchas
- Do not move async startup work to module top level. TUI plugins need to stay IPC-safe during initial load.
- Keep keyboard handling cleanup explicit so repeated hot reloads do not stack listeners.
- Validate that the command name triggered from the key handler still matches OpenCode's timeline action.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Runtime smoke: verify the built TUI entrypoint still loads via the `./tui` export without JSX/runtime regressions

## License

MPL-2.0
