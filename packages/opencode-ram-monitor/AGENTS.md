# opencode-ram-monitor — OpenCode plugin

**Technology**: TypeScript / OpenCode Plugin / OpenTUI
**Entry Point**: `src/tui.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: V2 (`@opencode/plugin >=2.1.0 <3`) — TUI-only, single `tui.js` entry. Versions stay on 2.x; 3.x is reserved for OpenCode V3.

This package is a TUI-only plugin: a sidebar widget (full card or one-line minimal layout) with lightweight RAM polling, plus a `/ram` modal (also opened by clicking the widget). OpenCode V2 runs one shared server per user, so RAM is reported by role — **OpenCode** (this TUI + its server) and **Tools** (the server's subtree + orphaned terminal daemons) — not per session.

## Quick Reference

| Script              | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `bun run check`     | Lint and format (Biome)                                   |
| `bun run lint`      | Validate without modifying                                |
| `bun run ci`        | CI mode (non-mutating)                                    |
| `bun run typecheck` | Type check                                                |
| `bun test`          | Run tests                                                 |
| `bun run build`     | Build the TUI output and declarations                     |
| `bun run smoke`     | Build, then load the entry through OpenCode's resolver    |

## Development Commands

### This Package
```bash
# From package directory
bun run build
bun test
bun run typecheck
bun run lint
bun run smoke
```

### From Root
```bash
bun --filter @capybearista/opencode-ram-monitor build
bun --filter @capybearista/opencode-ram-monitor test
```

### Pre-PR Checklist
```bash
bun --filter @capybearista/opencode-ram-monitor typecheck && \
bun --filter @capybearista/opencode-ram-monitor lint && \
bun --filter @capybearista/opencode-ram-monitor test && \
bun --filter @capybearista/opencode-ram-monitor smoke
```

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use the debug helpers in `src/debug.ts` so failures can be correlated without polluting chat output.
- Colocate one test file per module (`src/<module>.test.ts`).
- Imports: builtins first, then external, then relative.

## Architecture

### Directory Structure
```text
src/
├── tui.ts        # V2 TUI entry: sidebar widget (full/minimal), /ram modal, keymap command
├── options.ts    # Plugin options parsing (layout, refreshIntervalMs) with warnings
├── measure.ts    # Server pid lookup, process inspection, OpenCode/Tools attribution
├── tree.ts       # /ram modal markdown: TUI, server, and terminal trees
├── command.ts    # Command-line parsing: server/pty-daemon detection, display labels
├── format.ts     # Byte formatting and width-bounded row formatters
├── snapshot.ts   # ps/wmic process snapshot and parsers
├── theme.ts      # V2 theme-token adapter for widget and modal
└── debug.ts      # File-backed debug logging and error messages
```

### Core (understand these first)
- `src/tui.ts` — widget with recursive `setTimeout` polling and cleanup on unmount; dependencies (`inspect`, `selfRss`) are injectable through `createRamMonitorPlugin` for tests; the default export is the real plugin
- `src/measure.ts` — `inspectProcesses` asks `client.server.info()` for the server pid and trusts it only when the local snapshot shows an `opencode … serve` command there; `measureRam` splits the TUI's share (stopping at any server process) from the server's subtree and orphaned `opencode-pty daemon` processes under the home directory
- `src/options.ts` — the only config surface: the plugin's `cli.json` `options`

### Build
- `tsc --project tsconfig.build.json --emitDeclarationOnly` emits type declarations
- `bun build src/tui.ts` compiles the TUI entry
- `package.json` exports only `./tui`, with a package-root `tui.js` wrapper (no `main`, no `.` export, no `oc-plugin` key)

### Gotchas
- Never add a package-root or `./server` export, `main`, or a root `server.js`: OpenCode resolves `<pkg>/server`, then `<pkg>` itself, as a server entry. The smoke script asserts that no server entry resolves.
- `cli.json` entries must use the object form `{ "package", "options" }`. A V1 tuple entry fails the whole `cli.json` decode and OpenCode silently ignores the file.
- OpenCode re-activates the plugin when its options change, so options are parsed once in `setup`; do not add a config-file watcher.
- Do not introduce top-level async work in `src/tui.ts`; keep polling startup inside `onMount`.
- Use recursive `setTimeout`, not `setInterval`, so RAM probes cannot overlap.
- Rows must fit the sidebar: 33 columns inside the full card, 37 for the minimal line. `format.test.ts` asserts worst-case widths; keep `wrapMode: "none"` + `truncate` on row text.
- Process inspection is one `ps -A -o pid= -o ppid= -o rss= -o command=` snapshot per poll (`wmic process get ... /format:value` on Windows) in `src/snapshot.ts`. Validate changes on each OS; `docs/opencode-plugin-ipc-and-os-patterns.md` covers the platform hazards (wmic parsing, hidden windows, polling hygiene).
- The modal opens with `dialog.clear()`, then `show()`, then `set({ size: "xlarge" })` — order matters because `show()` resets the size.
- The `/ram` keymap layer is registered inside the `app` slot render, kept from the 2.0.x port. OpenCode 2.1.x also allows `keymap.layer()` from `setup` (it falls back to the host's owner and is removed when the plugin deactivates), so this is a choice, not a host rule; if you keep it in the slot, keep the dedupe guard.
- The OpenTUI preload must be registered under `[test]` in `bunfig.toml`; importing it from a test file runs too late and leaves `solid-js` on its server build, where `onMount` never fires.

## Testing Guidelines

- Location: colocated, one file per module
- Framework: bun test
- Running Tests: `bun test`
- Widget and modal tests render for real with `testRender` and inject fake `inspect`/`selfRss`; avoid `mock.module`, which leaks across files in one bun process
- Runtime smoke: `bun run smoke` resolves the built package through `@opencode/plugin/host`, asserts no server entry, and registers the TUI entry against a fake context

## License

MPL-2.0
