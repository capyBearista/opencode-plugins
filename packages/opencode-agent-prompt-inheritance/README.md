# opencode-agent-prompt-inheritance

<p align="center">Keep model rules when custom agents add guidance</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agent-prompt-inheritance"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-agent-prompt-inheritance?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agent-prompt-inheritance"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-agent-prompt-inheritance?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

> [!IMPORTANT] V2
> A V2 port is TBD. The V1 prompt-sync workflow remains enabled.

## Why?

> Custom agents are useful, but they should add task-specific guidance without throwing away the model-family rules OpenCode already provides. This plugin restores that inheritance so reviewer or specialist agents can keep the base prompt and still steer behavior.

## Philosophy: Extending OpenCode

This plugin stays narrow: it resolves the active agent from the current session and stitches the active provider prompt back in when inheritance is enabled. It does not change OpenCode core or add new commands.

### Architecture

```text
src/
├── index.ts            # Plugin entry point
├── inheritance.ts      # Inheritance flag parsing + prompt stitching
├── provider-prompt.ts  # Model-family prompt selection
└── prompt/             # Vendored upstream prompt assets (.txt)
```

## Features

- **Agent frontmatter**: reads the inheritance setting from the active session's custom agent.
- **Key aliases**: supports `inherit-base-prompt` and `inheritBasePrompt`.
- **Value modes**: accepts `false`, `true`, `prepend`, and `append`.
- **Prepend default**: treats `true` as `prepend`.
- **Non-destructive**: keeps other system prompt parts intact.
- **Vendored prompts**: uses vendored upstream prompt files to mirror OpenCode provider behavior.
- **Debug capture**: supports optional env-gated JSONL prompt capture for debugging.


## Install

### OpenCode V1

Add it under the `"plugin"` key in `opencode.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-agent-prompt-inheritance@1.0.0"]
}
```

Server entry only, so `tui.json(c)` needs no entry.

See the [V1 plugin guide](../../docs/v1-plugins.md) for details.

### Uninstall

Remove the plugin from `"plugin(s)"` from the respective config files they were added to.

## Usage

Create an agent file with inheritance enabled:

```md
---
name: reviewer
mode: subagent
inherit-base-prompt: prepend
---

Review code for correctness, risk, and missing tests.
```

`prepend` and `true` both place the provider prompt before the current system prompt. `append` places it after.

## Configuration

| Frontmatter key | Type | Meaning |
| --- | --- | --- |
| `inherit-base-prompt` | `false \| true \| prepend \| append` | Controls provider prompt inheritance |
| `inheritBasePrompt` | `false \| true \| prepend \| append` | CamelCase alias for the same setting |

## Supported Model Families

The plugin selects the appropriate base prompt based on the model ID. All checks are case-insensitive.

| Model ID pattern | Prompt used |
| --- | --- |
| `gpt-4*`, `o1*`, `o3*` | Beast prompt |
| `*codex*` | Codex prompt |
| `*copilot*` | Copilot GPT-5 prompt |
| `*gpt*` | GPT prompt |
| `*gemini-*` | Gemini prompt |
| `*claude*` | Anthropic prompt |
| `*trinity*` | Trinity prompt |
| `*kimi*` | Kimi prompt |
| (anything else) | Default prompt |

## Debug Capture

If you want to inspect the transformed `system` prompt after this plugin runs, set:

```bash
export OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE=/tmp/opencode-agent-prompt-inheritance.jsonl
```

When this variable is set, the plugin appends one JSON line per transformed session containing:

- `timestamp`
- `sessionID`
- `agentName`
- `modelID`
- `mode`
- `inherited`
- `system`

If the variable is unset, no capture file is written.

## Troubleshooting

- If nothing changes, confirm the active agent has one of the inheritance keys and the value is valid.
- If the active agent cannot be resolved, the plugin leaves the system prompt untouched.
- Prompt updates are synced from upstream OpenCode (`anomalyco/opencode`) via the `Sync OpenCode Prompts` workflow and opened as PRs.
- If you are using debug capture, remember that `.jsonl` files are local artifacts and are ignored by git.

## Contributing

This package lives in the `opencode-plugins` monorepo.

See the [contribution guidelines](../../CONTRIBUTING.md) before opening a pull request.

- From the monorepo root, run `bun run build` before artifact checks, then `bun run typecheck`,`bun run lint`, and the canonical `bun run test` Turbo pipeline. Do not use bare root `bun test` as the workspace check.
- For a focused run, `bun test` is supported from this package directory; its tests include the real local-directory resolver regression.
- `bun run check` writes Biome changes; use it only when formatting changes are intended.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](./LICENSE.txt)
