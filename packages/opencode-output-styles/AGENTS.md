# opencode-output-styles — OpenCode plugin

**Technology**: TypeScript / OpenCode V2 plugin (server + TUI)
**Entry Points**: `src/server.ts` (server), `src/tui.ts` (TUI)
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: OpenCode >= 2.0.23 (2.x line, `latest`). The 1.x line (V1) is frozen at 1.0.2.

## Quick Reference

| Script              | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `bun run check`     | Lint and format (Biome)                   |
| `bun run lint`      | Validate without modifying                |
| `bun run ci`        | CI mode (non-mutating)                    |
| `bun run typecheck` | Type check                                |
| `bun test`          | Run tests                                 |
| `bun run build`     | Declarations (tsc) + bundles (bun build)  |
| `bun run smoke`     | Build, then check both built entries load |

### Pre-PR Checklist
`bun --filter @capybearista/opencode-output-styles typecheck && \
bun --filter @capybearista/opencode-output-styles lint && \
bun --filter @capybearista/opencode-output-styles test && \
(cd packages/opencode-output-styles && bun run smoke)
`

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`.
- Colocate tests with source files (`src/*.test.ts`).
- Imports: builtins first, then external, then relative.

## Architecture

- `src/server.ts` registers the `output-styles` RPC and one `session.hook("context")` callback.
- `src/tui.ts` registers the `/output-style` command, the picker, and the `sidebar.content` line.
- `src/rpc.ts` is the contract both halves import.
- `src/styles.ts` handles discovery and parsing. `src/prompt.ts` holds the pure prompt and reminder helpers.
- `built-in-styles/*.md` are published assets loaded at runtime from `../built-in-styles` relative to the module, which works from both `src/` and `dist/`.

### Gotchas
- **One `opencode.json` entry loads both halves.** The TUI half gets `context.options = {}`, so every option is read on the server and handed to the TUI through the `state` RPC.
- **`@opencode/plugin` must stay a required peer.** OpenCode 2.0.23–2.0.24 servers do not provide the SDK to plugins. The OpenTUI and solid peers are optional.
- **`session.update({ metadata })` replaces the whole object.** Always read, merge, then write.
- **Subagent sessions inherit metadata.** Skip sessions with `parentID`.
- **The TUI's cached session does not re-render on metadata changes.** The sidebar is driven by a signal fed from `session.metadata.updated`.
- **RPC inputs must be objects.** Pass `{}` when a method takes nothing.
- **Every TUI RPC call carries a `location`.** The shared server runs one plugin instance per project; use the session's location for session calls, else the TUI's.
- **Only real prompts get the reminder.** Synthetic, skill, shell and compaction messages are also `role: "user"`; the hook matches ids against `session.context` entries with `type: "user"`.
- **The `context` hook must never throw into the user's request.** Failures are swallowed.
- **Built-in prompts come from Claude Code 2.1.310.** They were extracted from the binary bytes (`strings` drops short lines). See [the findings doc](../../docs/output-styles/v2-port-findings.md) before refreshing them.

## Testing Guidelines

- Location: colocated. Framework: `bun test`, with `bunfig.toml` preloading `@opentui/solid/preload` for the TUI tests.
- Tests must not read the real `HOME`: pass `env` to `discoverStyles` or set `OPENCODE_CONFIG_DIR` to a temp dir.
- Runtime changes (hooks, RPC, TUI wiring) need a live check against a packaged build. The sandbox recipe is in the findings doc.

## License

MPL-2.0
