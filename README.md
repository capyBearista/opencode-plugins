<p align="center"><img src=".github/assets/capybearista-wordmark.svg" width="325" />
<p align="center">
  <a href="https://github.com/capybearista/opencode-plugins">
    <picture>
      <source srcset=".github/assets/opencode-plugins-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/opencode-plugins-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/opencode-plugins-light.svg" alt="OpenCode Plugins logo" width="600">
    </picture>
  </a>
</p>
<p align="center">
  <!-- <a href="https://www.npmjs.com/package/@capybearista/opencode-plugins"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-plugins?style=flat-square&color=8d60e6" /></a> -->
  <a href="https://www.npmjs.com/~capybearista"><img alt="npm downloads" src="https://img.shields.io/endpoint?url=https://dry-haze-b628.capybearista.workers.dev&style=flat-square&color=%236067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugins-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>
<p align="center">
  <a href="https://github.com/capybearista/opencode-plugins/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/capybearista/opencode-plugins/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="https://deepwiki.com/capybearista/opencode-plugins"><img alt="ask deepwiki" src=".github/assets/deepwiki.svg" /></a>
</p>

A collection of plugins for the OpenCode AI harness. These extensions add quality-of-life improvements, user interface features, and new configuration standards.

## Meet The Plugins

### 🤺 [opencode-adversarial-review](./packages/opencode-adversarial-review/)

Adversarial code review that challenges your implementation approach and design choices, not just finding bugs. Uses a clean-context subagent so the review stays unbiased by conversation history, prioritizing auth gaps, data loss, etc. Returns structured JSON findings with severity, confidence scores, and recommendations.

*Inspired by Codex*

### 🐏 [opencode-ram-monitor](./packages/opencode-ram-monitor/)

Zero-dependency RAM monitoring for OpenCode sessions. Shows live session memory usage in the sidebar and adds a `/ram` command for a detailed process tree and aggregate OpenCode RAM totals.

### 🗣️ [opencode-output-styles](./packages/opencode-output-styles/)

Persistent response styles for OpenCode sessions. This plugin injects selected guidelines (like "explanatory" or "learning" modes) into the system prompt so they stay active across your session.

*Inspired by Claude Code*

### 🛠️ [opencode-agents-loader](./packages/opencode-agents-loader/)

Extends command and agent discovery to the `.agents/` directory standard. This enables interoperability with other AI tools and keeps project configuration organized.

### ⏱️ [opencode-double-tap-timeline](./packages/opencode-double-tap-timeline/)

A keyboard-driven UI extension. Double-tap the Escape key to instantly open the session timeline modal without typing commands or using a mouse.

*Inspired by Claude Code*

## Installation

You can install any of these plugins globally or project-locally using the OpenCode CLI:

```bash
opencode plugin add -g @capybearista/opencode-adversarial-review@latest    # global install
opencode plugin add @capybearista/opencode-adversarial-review@latest       # project-local install
```

Alternatively, add them directly to your `opencode.json`/`opencode.jsonc` configuration file:

```json
{
  "plugin": [
    "@capybearista/opencode-adversarial-review@latest",
    "@capybearista/opencode-ram-monitor@latest",
    "@capybearista/opencode-output-styles@latest",
    "@capybearista/opencode-agents-loader@latest"
  ]
}
```

For **TUI-based plugins**, add them directly to `tui.json`/`tui.jsonc`:

```json
{
  "plugin": ["@capybearista/opencode-double-tap-timeline@latest"]
}
```

### Updating

OpenCode does NOT care about the `@latest` tag after initial installation of a plugin. Instead, you must either manually set and change the tag (e.g., `@1.0.0` to `@2.0.0`) or simply run this command:

```bash
rm -rf ~/.cache/opencode/packages/<plugin-name>@latest/
opencode plugin <plugin-name>@latest --global
```

## What Should I Build Next?

Every plugin here started because someone hit a wall with OpenCode and thought _"there's gotta be a better way."_

I usually browse through [Reddit](https://reddit.com/r/opencodecli) and the GitHub Issues section of the [OpenCode](https://github.com/anomalyco/opencode) repo, noticing people griping about their workflows. But if you've got a concrete idea and want to put it directly in front of me, I'm all ears :)

<span>&#8611;</span> Got a brand-new plugin idea? [Open a plugin proposal issue](https://github.com/capybearista/opencode-plugins/issues/new?template=new_plugin_proposal.yml).

<span>&#8611;</span> Already using a plugin and something's off? Or maybe you've got an idea to enhance an existing plugin or the monorepo itself? [Open a feature request issue](https://github.com/capybearista/opencode-plugins/issues/new?template=feature_request.yml).

## Shoutouts

Plugins I've personally used and highly recommend! Some of these are genuinely underrated and have massive potential.

| Name                                                                             | Use case                                                         | Description                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [opencode-quota](https://github.com/slkiser/opencode-quota)                      | Keep track of your provider subscriptions _in_ OpenCode          | Token usage and quota tracking for Anthropic, OpenAI, Copilot, and more—reports in terminal with zero context pollution.                                                           |
| [opencode-snippets](https://github.com/JosXa/opencode-snippets)                  | Expand `#tags` into text anywhere, instantly                     | Hashtag-based snippet expansion. Just type `#name` to inject pre-defined code blocks, configs, or prompts inline. You can even put them in commands.                               |
| [opencode-dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) | Caps token waste from stale context                              | Context-aware compression intelligently prunes old tool outputs to keep context lean and reduce token burn.                                                                        |
| [cc-safety-net](https://github.com/kenryu42/claude-code-safety-net)              | Prevents dangerous commands like `rm -rf` and `git reset --hard` | Intercepts destructive git and filesystem commands before they execute, giving you a chance to abort before your agent deletes your entire project.                                |
| [opencode-command-hooks](https://github.com/shanebishop1/opencode-command-hooks) | Run scripts on session events without writing a plugin           | Declarative event hooks for shell commands via YAML/JSON. You can even attach scripts to lifecycle events like `tool.execute.after`.                                               |
| [opencode-agent-identity](https://github.com/gotgenes/opencode-agent-identity)   | Distinguish which sub-agent said what in multi-agent sessions    | Per-message attribution so each agent knows its role and which message came from which source.                                                                                     |
| [opencode-mem](https://github.com/tickernelz/opencode-mem)                       | Retain long-term context across sessions                         | Persistent memory for AI coding agents with SQLite + USearch indexing, automatic user profile learning, and a visual web UI. It's even got a nice web UI to check stored memories! |
| [opencode-notifier](https://github.com/mohak34/opencode-notifier)                | Know when sessions finish without watching the terminal          | Highly customizable desktop notifications and sounds for permission prompts, completion, and errors so you never miss a beat.                                                      |

## Development

This project is a monorepo managed with Bun and Turborepo.

```bash
# Install dependencies
bun install

# Build all plugins
bun run build

# Run tests
bun run test
```

Please review the [contribution guidelines](./CONTRIBUTING.md) before contributing :)

## Disclaimer

This project is not affiliated with the anomalyco/opencode team in any way. These plugins are independently developed and maintained. I do this for the love of the game ¯\\_(ツ)_/¯

## License

[MPL-2.0](./LICENSE.txt)
