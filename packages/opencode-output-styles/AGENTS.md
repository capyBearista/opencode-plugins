# opencode-output-styles — OpenCode plugin

**Technology**: TypeScript / OpenCode Plugin
**Entry Point**: `src/index.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: V1-only plugin (latest channel); there is no V2 port.

## Quick Reference

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `bun run check`     | Lint and format (Biome)    |
| `bun run lint`      | Validate without modifying |
| `bun run ci`        | CI mode (non-mutating)     |
| `bun run typecheck` | Type check                 |
| `bun test`          | Run tests                  |
| `bun run build`     | Compile TypeScript         |

## Development Commands

### This Package
`# From package directory
bun run build
bun test
bun run typecheck
bun run lint
`

### From Root
`bun --filter @capybearista/opencode-output-styles build
bun --filter @capybearista/opencode-output-styles test
`

### Pre-PR Checklist
`bun --filter @capybearista/opencode-output-styles typecheck && \
bun --filter @capybearista/opencode-output-styles lint && \
bun --filter @capybearista/opencode-output-styles test
`

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use structured approaches for logging/debugging.
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative.

## Architecture

### Directory Structure
`src/
├── index.ts          # Plugin entry point
├── styles.ts         # Built-in style definitions and discovery helpers
└── index.test.ts     # Runtime behavior tests
built-in-styles/      # Packaged style definitions shipped with the plugin
`

### Core (understand these first)
- `src/index.ts` — style discovery, activation, persistence, and prompt injection
- `src/index.test.ts` — verifies `/style` persistence and system prompt appending
- `built-in-styles/` — packaged style definitions shipped with the plugin and loaded at runtime

## Modular Structure

As the plugin grows beyond 150 lines, split into focused modules. If that happens, `src/hooks/` and `src/tools/` are the suggested directories for hook implementations and custom tool definitions; neither exists today.

### Gotchas
- Prompt injection changes should always be cross-checked against `docs/opencode-system-prompt-guide.md` and local style persistence tests.
- Built-in styles are published assets. Keep runtime code and packaged file layout in sync.
- This plugin relies on stable append/prepend behavior. When changing text composition, verify restarts and repeated `/style` usage.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Runtime smoke: verify the package root still exposes the plugin and the built-in styles directory is present in the published file set

## License

MPL-2.0
