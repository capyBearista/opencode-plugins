# opencode-agent-prompt-inheritance

<p align="center">Keep model rules when custom agents add guidance</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agent-prompt-inheritance"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-agent-prompt-inheritance?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agent-prompt-inheritance"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-agent-prompt-inheritance?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Why?

> Custom agents are useful, but they should add task-specific guidance without throwing away the model-family rules OpenCode already provides. This plugin restores that inheritance so reviewer or specialist agents can keep the base prompt and still steer behavior.

## Philosophy: Extending OpenCode

This plugin stays narrow: it only touches `experimental.chat.system.transform`, resolves the active agent from the current session, and stitches the active provider prompt back in when inheritance is enabled. It does not change OpenCode core or add new commands.

### Architecture

```text
src/
├── index.ts            # Hook entry point
├── inheritance.ts      # Inheritance flag parsing + prompt stitching
├── provider-prompt.ts  # Model-family prompt selection
└── prompt/             # Vendored upstream prompt assets (.txt)
```

## Features

- Reads custom agent frontmatter from the active session
- Supports `inherit-base-prompt` and `inheritBasePrompt`
- Accepts `false`, `true`, `prepend`, and `append`
- Treats `true` as `prepend`
- Keeps other system prompt parts intact
- Uses vendored upstream prompt files to mirror OpenCode provider behavior
- Supports optional env-gated JSONL prompt capture for debugging

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

## Install

Add the plugin to `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@capybearista/opencode-agent-prompt-inheritance"]
}
```

You can also install it through the CLI:

```bash
opencode plugin -g @capybearista/opencode-agent-prompt-inheritance
opencode plugin @capybearista/opencode-agent-prompt-inheritance
```

## Updating

Clear the cached package before restarting OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/'opencode-agent-prompt-inheritance@latest'/
```

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
- If the active agent cannot be resolved, the hook leaves the system prompt untouched.
- Prompt updates are synced from upstream OpenCode (`anomalyco/opencode`) via the `Sync OpenCode Prompts` workflow and opened as PRs.
- If you are using debug capture, remember that `.jsonl` files are local artifacts and are ignored by git.

## License

[MPL-2.0](./LICENSE.txt)
