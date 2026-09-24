# opencode-agent-prompt-inheritance — OpenCode plugin

**Technology**: TypeScript / OpenCode Plugin
**Entry Point**: `src/index.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)

This package preserves the base provider system prompt when a custom agent sets its own instructions. It hooks `experimental.chat.system.transform`, discovers the active agent from session history, and stitches provider prompt text before or after the custom agent prompt.

**V1-only**: V2 prompt inheritance is discontinued — do not port the transform hook to a V2 plugin.

## Quick Reference

| Script                 | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `bun run check`        | Lint and format (Biome)                        |
| `bun run lint`         | Validate without modifying                     |
| `bun run ci`           | CI mode (non-mutating)                         |
| `bun run typecheck`    | Type check                                     |
| `bun test`             | Run tests                                      |
| `bun run build`        | Compile plugin and copy bundled prompt files   |
| `bun run sync:prompts` | Refresh V1 provider prompt fixtures from upstream (V1-only workflow) |

## Development Commands

### This Package
`# From package directory
bun run build
bun test
bun run typecheck
bun run lint
bun run sync:prompts
`

### From Root
`bun --filter @capybearista/opencode-agent-prompt-inheritance build
bun --filter @capybearista/opencode-agent-prompt-inheritance test
`

### Pre-PR Checklist
`bun --filter @capybearista/opencode-agent-prompt-inheritance typecheck && \
bun --filter @capybearista/opencode-agent-prompt-inheritance lint && \
bun --filter @capybearista/opencode-agent-prompt-inheritance test
`

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- Avoid changing prompt text inline in multiple places; keep composition logic centralized.
- Colocate tests with source files (`src/index.test.ts`, `src/artifact.test.ts`).
- Imports: builtins first, then external, then relative.

## Architecture

### Directory Structure
`src/
├── index.ts             # Plugin entry and transform hook
├── inheritance.ts       # Option parsing and prompt stitching rules
├── provider-prompt.ts   # Model/provider prompt selection
├── prompt-capture.ts    # Optional debug capture sink
├── prompt/              # Bundled provider prompt fixtures copied at build time
├── index.test.ts        # Transform behavior tests
└── artifact.test.ts     # Built artifact assertions
`

### Core (understand these first)
- `src/index.ts` — looks up the active agent from recent session messages, resolves `inherit-base-prompt`, and rewrites `output.system[0]`
- `src/inheritance.ts` — normalizes `inherit-base-prompt` / `inheritBasePrompt` and defines prepend vs append behavior
- `src/provider-prompt.ts` — maps model ids to the bundled provider prompt fixtures
- `src/prompt-capture.ts` — opt-in debug capture behind `OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE`

### Gotchas
- This package depends on `experimental.chat.system.transform`; re-check `docs/opencode-system-prompt-guide.md` before changing hook assumptions.
- Session lookup failures intentionally fail open. Preserve that behavior unless you are explicitly hardening the plugin.
- Build output includes prompt assets copied into `dist/prompt/`; artifact regressions are as important as TypeScript regressions.
- `console.warn` is intentional here for fail-open debugging in transform-hook paths where richer logging is not guaranteed.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Runtime smoke: verify the plugin still loads from `.opencode/opencode.json` and that a custom agent with `inherit-base-prompt` actually receives the stitched system prompt

## License

MPL-2.0
