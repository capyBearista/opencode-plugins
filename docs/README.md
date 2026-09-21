# Documentation

The root [README](../README.md) and package READMEs describe current installation and usage. The [V1 guide](./v1-plugins.md) retains instructions for the frozen releases whose package READMEs now describe V2. Contributor checks and release procedures live in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Map

| Document | Status | What it is |
| --- | --- | --- |
| [v1-plugins.md](./v1-plugins.md) | Active | V1 install, pinning, and compatibility: frozen versus still-moving packages, `opencode.json` / `tui.json` config, and the V2 boundary. |
| [migration-guide-1.15.md](./migration-guide-1.15.md) | Scoped snapshot | 1.15 Effect-native migration notes. Historical reference; kept as is. |
| [plugin-system-1.15.md](./plugin-system-1.15.md) | Scoped snapshot | 1.15 internals deep dive (`EventV2`, Zod bridge, `WithInstance` removal). Historical reference; kept as is. |
| [opencode-system-prompt-guide.md](./opencode-system-prompt-guide.md) | V1 reference | How OpenCode V1 assembles its system prompt and where the `experimental.chat.system.transform` hook fits. Background for output-styles and prompt-inheritance contributors. |
| [opencode-plugin-ipc-and-os-patterns.md](./opencode-plugin-ipc-and-os-patterns.md) | Plugin-author reference | IPC and cross-platform patterns learned from building these plugins. |
| [output-styles/claude-output-styles.md](./output-styles/claude-output-styles.md) | Upstream reference | Snapshot of Claude Code output-style docs. Background for the output-styles plugin, not a statement of this repo's behavior. |
| [ram-monitor/post-mortem-v1.0.0.md](./ram-monitor/post-mortem-v1.0.0.md) | Package note | What broke and what fixed it during ram-monitor 1.0.0 stabilization. |
| [ram-monitor/codex-comparison.md](./ram-monitor/codex-comparison.md) | Package note | Prompt-structure comparison between the official Codex plugin and this repo's review plugin. |

## Generated prompt sources

`packages/opencode-agent-prompt-inheritance/src/prompt/*.txt` are synced from upstream `anomalyco/opencode` (`packages/opencode/src/session/prompt/`, nine files). The `sync:prompts` script and the Sync OpenCode Prompts workflow fetch them and open PRs. Treat the copies as generated: do not hand-edit them outside the sync.

The V1 prompt-sync workflow stays on. There is no V2 prompt-inheritance port.

## Bundled skill references

`.agents/skills/` bundles reference material for contributors and agents (`bun`, `biome`, `opentui`, `opentui-design`). Each skill owns its `SKILL.md` and `references/` directory. Leave the contents alone and do not reformat them.

Provenance notes ship with the skill where they exist. The Biome skill carries its own `LICENSE.txt` and changelog. Do not invent ownership or license claims for the rest.

## Conventions

Dated documents retain their scope banners and existing paths. Prefer links to current installation instructions rather than copying them; the V1 guide is the explicit compatibility reference for frozen releases. Update navigation and inbound links together if documents move.
