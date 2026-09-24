# opencode-agents-loader — OpenCode plugin

**Technology**: TypeScript / OpenCode V2 Plugin (`@opencode/plugin` 2.0.2)
**Entry Point**: `server.js` (package root) → `src/index.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)

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
`bun --filter @capybearista/opencode-agents-loader build
bun --filter @capybearista/opencode-agents-loader test
`

### Pre-PR Checklist
`bun --filter @capybearista/opencode-agents-loader typecheck && \
bun --filter @capybearista/opencode-agents-loader lint && \
bun --filter @capybearista/opencode-agents-loader test
`

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use structured approaches for logging/debugging.
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative.

## V2 Install, Channels, and Compatibility

- This package is **V2-only**, version **2.0.0**, published on the **`opencode2`** channel for
  OpenCode V2 hosts. The frozen V1 `latest` release stays at **1.0.0**; do not install the V2
  package in a V1 host. See [../../docs/v1-plugins.md](../../docs/v1-plugins.md) for the frozen V1
  setup and [./README.md](./README.md) for the full install recipe.
- Server plugins register in the V2 server profile (`~/.config/opencode/opencode.json`) under the
  **plural `"plugins"`** key:

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["@capybearista/opencode-agents-loader@opencode2"]
  }
  ```

  Use the exact `@2.0.0` pin instead of `@opencode2` for a fixed setup. `@latest` resolves the
  frozen V1 line; `@v2` is a semver range, not a channel. V2 CLI actions are
  `opencode2 plugin add`, `check`, and `update`; a restart alone does not upgrade a cached target.
- A filesystem directory target is resolved through the package-root `server.js` wrapper (which
  re-exports `dist/index.js`), so build before registering a local directory. Do not point the
  config at `server.js` or `dist/index.js` directly.
- Keep the V2 profile separate from any V1 configuration. V1 and V2 may share the default
  `~/.config/opencode/` directory; use `OPENCODE_CONFIG_DIR` (plus separate data/state/cache/home
  locations) for isolation. The plugin does not migrate configuration or session data.
- Discovery walks lexical `.agents/` scopes from the declared project root down to the current
  working directory (plus global `~/.agents/`). A current working directory outside the declared
  project root is rejected safely; discovery never broadens to `/`.
- The bridges create **managed relative symlinks** from `.agents/{command,commands,agent,agents}/`
  into the matching native `.opencode/` directories and own them through per-domain manifests and
  locks under `.agents-loader/`. Only exact recorded symlinks are removed; unowned native files,
  aliases, and explicit config entries are preserved.
- Agent frontmatter is validated by `agent-source.ts` before an agent link is created. Invalid or
  unsupported V1/V2 metadata (malformed permissions, mixed legacy `tools`/`permission` with V2
  `permissions`, unknown V2 `request` fields) is skipped with a diagnostic rather than silently
  widening tool access.
- The returned dispose function clears both bridges' timers; reload signals are emitted via
  `ctx.command.reload()` / `ctx.agent.reload()` once per observed change, but a host rescan or
  restart may still be required.

## Architecture

### Directory Structure
```text
server.js               # Package-root V2 entry, re-exports dist/index.js
src/
├── index.ts            # Plugin.define default export + registerPlugin
├── command-bridge.ts   # startAgentBridge / startCommandBridge, sync + dispose + reload
├── agent-source.ts     # V1/V2 frontmatter decode, sanitize, validation
└── index.test.ts       # Runtime behavior tests
```

### Core (understand these first)
- `server.js` — package-root wrapper. A filesystem directory install resolves here, not through
  the `exports` map; it intentionally exposes no TUI or RPC entrypoint.
- `src/index.ts` — default export is `Plugin.define({ id: "capybearista.opencode-agents-loader", setup })`;
  `registerPlugin(context, options)` starts the command and agent bridges (command first), disposes
  both on setup failure, and returns an idempotent dispose function.
- `src/command-bridge.ts` — `startCommandBridge` / `startAgentBridge`, `syncCommandLinks` /
  `syncAgentLinks`, and the bridge handle types. Materializes per-scope links, records ownership in
  separate manifests and locks, polls bounded censuses, emits reload signals, and disposes timers.
- `src/agent-source.ts` — `parseMarkdown` / `parseMarkdownContent` (V1/V2 frontmatter decode),
  `fallbackSanitization`, `validateAgentContent`, and `convertAgent`; gates agent links.
- `src/index.test.ts` — verifies the plugin id, the server export, and bridge behavior.

### Gotchas
- This plugin extends discovery, it does not replace native OpenCode config loading. Native OpenCode
  owns frontmatter decoding, V1 migration, argument expansion, shell interpolation, subagent
  execution, permissions, and precedence. Validate native behavior, not just raw directory scanning.
- Source and config files are never rewritten. Prompt bodies and frontmatter bytes are never copied;
  the native loader follows the managed symlink.
- Keep `.agents/` compatibility logic conservative. The plural `commands/` spelling wins over
  `command/` at the same scope; nested names stay nested.
- When changing path resolution, test both repo-local `.agents/` content and user-home `~/.agents/`
  content, and preserve the fail-closed behavior for traversal, symlinked sources, and held locks.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Runtime smoke: verify the package root can still be loaded as a directory target from the V2
  server `opencode.json` `plugins` entry

## License

MPL-2.0
