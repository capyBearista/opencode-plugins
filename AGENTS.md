# opencode-plugins

## Overview
- **Type**: monorepo
- **Stack**: typescript / opencode-plugin
- **Package manager**: bun
- **Build system**: turborepo

This AGENTS.md is the authoritative source for development guidelines.
Subdirectories contain specialized files that extend these rules.

## Universal Development Rules

### Code Quality (MUST)
- **MUST** use TypeScript strict mode
- **MUST** include tests for all new features
- **MUST** run `bun run typecheck && bun run lint && bun run test && bun run build` before opening a PR
- **MUST NOT** commit secrets, API keys, or tokens

### Plugin Development (MUST)

Scope: V1 packages. The three V2 ports use the Promise API instead; see the V2 boundary below.

- **MUST** keep server and TUI entrypoints split. If a plugin exposes both, publish separate `./server` and `./tui` exports instead of exporting both from one module.
- **MUST** verify the real runtime path when testing local plugins. Check both the package build output and the harness config that OpenCode actually loads.
- **MUST NOT** use removed pre-1.15 plugin patterns like `WithInstance.provide()` or legacy string-based event buses.
- **SHOULD** add Zod `.describe()` metadata for every custom tool argument so OpenCode 1.15.x preserves useful schema descriptions for the model.
- **SHOULD** declare plugin metadata intentionally: `oc-plugin` for install targets and `peerDependencies`/`engines` that match the OpenCode version you support.

### V2 Boundary (MUST)

Three packages have V2 ports; three remain V1-only. [`docs/v1-plugins.md`](docs/v1-plugins.md) is the compatibility authority for V1 install, pinning, and the V2 boundary — link it instead of duplicating version tables.

| Package | V2 status |
| --- | --- |
| `opencode-agents-loader` | Ported: server plugin, plural `plugins` in `opencode.json` |
| `opencode-double-tap-timeline` | Ported: TUI plugin, plural `plugins` in `cli.json` |
| `opencode-adversarial-review` | V1 only |
| `opencode-agent-prompt-inheritance` | V1 only; V2 port discontinued |
| `opencode-output-styles` | V1 only |
| `opencode-ram-monitor` | Ported: dual server+TUI plugin, plural `plugins` (`opencode.json` + `cli.json`); `2.0.0` on `latest` |

- **MUST** use the V2 Promise API in ports: `Plugin.define({ id, setup })` from `@opencode/plugin` 2.x. Do not carry V1 `server`/`config` hook signatures into a port.
- **MUST** keep V2 entrypoints at the package root: `server.js` for the loader, `tui.js` for the timeline. Filesystem-local config points at the package directory, not the entry file.
- **MUST** use the plural `"plugins"` key and split host config: server plugins in `opencode.json`, TUI plugins in `cli.json`. V1 keeps the singular `"plugin"` key in `opencode.json` / `tui.json`.
- **MUST NOT** write `@v2` as a specifier — npm parses it as a semver range. Use the `opencode2` channel or an exact `@2.0.0` pin.
- **MUST** keep V1 and V2 lines apart. The loader and timeline V1 `latest` tags are frozen; both lines may share the default config directory, so use separate profiles (`OPENCODE_CONFIG_DIR`) for side-by-side testing.
- **SHOULD** manage V2 targets with `opencode2 plugin check` / `opencode2 plugin update`; a restart alone does not upgrade a cached target, and exact pins stay fixed.
- Channel source of truth: [`tools/release-channels.json`](tools/release-channels.json), enforced by [`tools/release-channel-guard.ts`](tools/release-channel-guard.ts).

### Bug Fix Workflow (MUST)
- **MUST** identify and record the root cause before broad fixes; for bugs/regressions, use the `systematic-debugging` skill first and escalate to `five-whys` if the cause remains unclear or review findings keep shifting.
- **MUST** verify the real runtime path when behavior depends on plugin loading, built artifacts, TUI/server wiring, or local OpenCode config. Do not trust unit tests alone for these cases.
- **MUST** stop and reframe after repeated review-fix loops. If a second review or adversarial pass finds a different root cause, do a fresh runtime/config investigation before more patching.

### Runtime Guardrails (MUST)
- For plugin runtime changes, **MUST** run a runtime smoke check in addition to tests/build. At minimum, verify the built module or package export that OpenCode actually loads.
- If local OpenCode config files are involved in testing (V1: `opencode.json` / `tui.json`; V2: `opencode.json` / `cli.json`), **MUST** verify they reference the package root or published plugin name, not a stale `dist/*` artifact path.
- For TUI/plugin regressions, **MUST** verify both the server path and the TUI path independently when the symptoms can split across them.
- For TUI plugins, **MUST NOT** block startup with top-level async initialization. Defer async work to mounted components and always register cleanup for polling/timers.

### Best Practices (SHOULD)
- **SHOULD** use `biome` for linting and formatting
- **SHOULD** use `changesets` for versioning

<!-- bootstrap:managed:start core-commands -->
## Core Commands

### Development
- `bun run build` — Build all packages
- `bun run test` — Run all tests
- `bun run typecheck` — Type validation
- `bun run lint` — Lint all code
- `bun run check` — Format and lint all packages
- `bun changeset` — Manage versioning and publishing
- `bun run changeset:publish` — Build and publish releasable packages

### Package-Specific
- `bun --filter [name] [command]` — Run in specific package

### Quality Gates (run before PR)
`bun run typecheck && bun run lint && bun run test && bun run build`
<!-- bootstrap:managed:end core-commands -->

<!-- bootstrap:managed:start project-structure -->
## Project Structure

### Packages
- **`packages/opencode-adversarial-review/`** → Adversarial code review plugin with a clean-context review subagent and `/adversarial-review` command (see `packages/opencode-adversarial-review/AGENTS.md`)
- **`packages/opencode-agent-prompt-inheritance/`** → Preserves provider system prompts when custom agents inject their own instructions (see `packages/opencode-agent-prompt-inheritance/AGENTS.md`)
- **`packages/opencode-agents-loader/`** → OpenCode plugin that extends command and agent discovery to ~/.agents/ and .agents/ directories (see packages/opencode-agents-loader/AGENTS.md)
- **`packages/opencode-double-tap-timeline/`** → OpenCode plugin (see packages/opencode-double-tap-timeline/AGENTS.md)
- **`packages/opencode-output-styles/`** → OpenCode plugin (see packages/opencode-output-styles/AGENTS.md)
- **`packages/opencode-ram-monitor/`** → Dual server/TUI plugin for live RAM telemetry and the `/ram` command (see `packages/opencode-ram-monitor/AGENTS.md`)

### Supporting Directories
- **`.agents/`** → Shared commands and skills used by local harness workflows
- **`docs/`** → Research notes, migration guides, prompt architecture references, and design docs
- **`tools/`** → Standalone utilities that are not part of the Bun workspace, including the release channel source of truth (`release-channels.json`, `release-channel-guard.ts`)
<!-- bootstrap:managed:end project-structure -->

<!-- bootstrap:managed:start jit-index -->
## Quick Find Commands

### Code Navigation
`# Find plugin hooks or commands
rg -n "export (default )?class .*Plugin" packages/

# Find server/TUI plugin entrypoints
rg -n "export default \{|const (server|tui):" packages/*/src

# Find prompt-transform plugins
rg -n "experimental\.chat\.system\.transform" packages/

# Find TUI slot registrations
rg -n "api\.slots\.register|sidebar_content|app_bottom" packages/
`
<!-- bootstrap:managed:end jit-index -->

## Security Guidelines

### Secrets Management
- **NEVER** commit tokens, API keys, or credentials
- Use `.env.local` for local secrets (already in .gitignore)
- Review generated bash commands before execution

## Git Workflow

- Use Changesets: `bun changeset` to record intent
- PRs require: typecheck, lint, test, build
- Squash commits on merge

## Testing Requirements
- **Unit tests**: colocated (bun test)
- Run tests before committing (enforced by CI)
- Add runtime smoke coverage or an explicit built-artifact verification step for plugin entrypoints, TUI render paths, or config-driven loading changes.

## Reference Docs

- Read `docs/plugin-system-1.15.md` before changing plugin architecture assumptions or documenting new OpenCode plugin capabilities.
- Read `docs/migration-guide-1.15.md` before planning V1 compatibility work; the V1 packages are already on the 1.15 plugin API.
- Read `docs/v1-plugins.md` before changing V1 install, pinning, or release-channel behavior; it is the compatibility authority for the frozen releases and the V2 boundary.
- Read `docs/opencode-system-prompt-guide.md` before changing system-prompt injection behavior.
- Read `docs/opencode-plugin-ipc-and-os-patterns.md` before changing TUI startup, polling, or OS-specific process inspection code.

## Available Tools

You have access to:
- Standard bash tools (rg, git, node, bun, etc.)
- GitHub CLI (`gh`) for issues, PRs, releases

### Tool Permissions
- ✅ Read any file
- ✅ Write code files
- ✅ Run tests, linters, type checkers

## Specialized Context

When working in specific directories, refer to their AGENTS.md:
- opencode-adversarial-review: packages/opencode-adversarial-review/AGENTS.md
- opencode-agent-prompt-inheritance: packages/opencode-agent-prompt-inheritance/AGENTS.md
- opencode-agents-loader: packages/opencode-agents-loader/AGENTS.md
- opencode-double-tap-timeline: packages/opencode-double-tap-timeline/AGENTS.md
- opencode-output-styles: packages/opencode-output-styles/AGENTS.md
- opencode-ram-monitor: packages/opencode-ram-monitor/AGENTS.md

## Project Keywords & Context

### What is OpenCode?
OpenCode is an open-source coding agent harness that runs in the terminal and helps users work with a codebase through natural-language instructions.

### Workspace Architecture
This repository uses **Bun Workspaces** for dependency management and **Turborepo** for fast, cached task execution.

- **Root Directory:** Contains centralized configurations (`biome.json`, `tsconfig.base.json`, `turbo.json`) and shared development dependencies.
- **`packages/` Directory:** Each subdirectory is an individual OpenCode plugin package.
- **Versioning:** This monorepo uses **Changesets** to manage independent versioning and publishing for each plugin.

### Agent Workflow
1. **Scaffolding:** Use the `init-plugin` skill to create a new plugin directory in `packages/`.
2. **Development:** Use the `create-plugin` skill. Work inside the specific package directory.
3. **Execution:** Run commands from the **root** using Turbo for speed, or within a package directory for specific tasks.
   - Root: `bun run build`, `bun run test`, `bun run lint`
4. **Releasing:** Use the `release-plugin` skill.
   - Run `bun changeset` at the root to record change intents.
