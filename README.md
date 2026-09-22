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

### 💬 [opencode-agent-prompt-inheritance](./packages/opencode-agent-prompt-inheritance/)

Preserves OpenCode provider system prompts when custom agents add their own instructions. Uses the `experimental.chat.system.transform` hook to stitch the base provider prompt and custom agent prompt together, preventing custom agents from discarding base model behaviors.

### 🛠️ [opencode-agents-loader](./packages/opencode-agents-loader/)

Extends command and agent discovery to the `.agents/` directory standard. This enables interoperability with other AI tools and keeps project configuration organized.

### ⏱️ [opencode-double-tap-timeline](./packages/opencode-double-tap-timeline/)

A keyboard-driven UI extension. Double-tap the Escape key to instantly open the session timeline modal without typing commands or using a mouse.

*Inspired by Claude Code*

### 🗣️ [opencode-output-styles](./packages/opencode-output-styles/)

Persistent response styles for OpenCode sessions. This plugin injects selected guidelines (like "explanatory" or "learning" modes) into the system prompt so they stay active across your session.

*Inspired by Claude Code*

### 🐏 [opencode-ram-monitor](./packages/opencode-ram-monitor/)

Zero-dependency RAM monitoring for OpenCode sessions. Shows live session memory usage in the sidebar and adds a `/ram` command for a detailed process tree and aggregate OpenCode RAM totals.

## Compatibility and release status

The OpenCode V2 releases of `opencode-agents-loader` and `opencode-double-tap-timeline`
are available as **2.0.0** on the **`opencode2`** channel. Do not
use `@v2`: npm parses that literal as a semver range, not as the intended channel.

The V1 lines remain separate. The V1 `latest` tag is frozen at `1.0.0` for the loader and
`1.0.1` for the timeline. The other four packages remain V1 packages in this release;
`opencode-agent-prompt-inheritance` has no V2 port, and RAM-monitor is not ported in this release.

| Plugin | V1 host and release | V2 line in this release |
| --- | --- | --- |
| `opencode-adversarial-review` | V1 `1.0.0`; server `opencode.json`, singular `plugin` | V1 only |
| `opencode-agent-prompt-inheritance` | V1 `1.0.0`; server `opencode.json`, singular `plugin` | V2 port discontinued |
| `opencode-agents-loader` | V1 `1.0.0`, frozen; server `opencode.json`, singular `plugin` | `2.0.0`; server `opencode.json`, plural `plugins`, channel `opencode2` |
| `opencode-double-tap-timeline` | V1 `1.0.1`, frozen; TUI `tui.json`, singular `plugin` | `2.0.0`; TUI `cli.json`, plural `plugins`, channel `opencode2` |
| `opencode-output-styles` | V1 `1.0.1`; server `opencode.json`, singular `plugin` | V1 only |
| `opencode-ram-monitor` | V1 `1.1.0`; server and TUI (`opencode.json` and `tui.json`), singular `plugin` | V1 only |

## Installation

### Existing V1 releases

Use these instructions with an OpenCode V1 host. V1 uses the singular `"plugin"` key and the
V1 CLI command is `plugin <module>`, not `plugin add`. Exact pins are supported; the examples
below use the current package versions rather than implying that a V2 release exists.

```bash
opencode plugin --global @capybearista/opencode-adversarial-review@1.0.0
opencode plugin @capybearista/opencode-adversarial-review@1.0.0
```

For V1 server plugins, add pinned entries to `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": [
    "@capybearista/opencode-adversarial-review@1.0.0",
    "@capybearista/opencode-agent-prompt-inheritance@1.0.0",
    "@capybearista/opencode-agents-loader@1.0.0",
    "@capybearista/opencode-output-styles@1.0.1",
    "@capybearista/opencode-ram-monitor@1.1.0"
  ]
}
```

For V1 TUI plugins, use `tui.json` or `tui.jsonc` and the same singular key:

```json
{
  "plugin": [
    "@capybearista/opencode-double-tap-timeline@1.0.1",
    "@capybearista/opencode-ram-monitor@1.1.0"
  ]
}
```

### V2 releases

V2 uses plural `"plugins"` and separates server and TUI configuration. Use the `opencode2`
channel or pin `2.0.0` explicitly; `latest` remains on the frozen V1 versions.

V2 server profile, `~/.config/opencode/opencode.json`, contains the loader only:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@capybearista/opencode-agents-loader@opencode2"]
}
```

V2 TUI profile, `~/.config/opencode/cli.json`, contains the timeline only:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@capybearista/opencode-double-tap-timeline@opencode2"]
}
```

Replace `@opencode2` with `@2.0.0` when an exact V2 pin is preferred. In a side-by-side
installation, use the V2 binary, `opencode2`. Its `plugin add` command routes the server-only
loader to server configuration and the TUI-only timeline to `cli.json`:

```bash
opencode2 plugin add @capybearista/opencode-agents-loader@opencode2
opencode2 plugin add @capybearista/opencode-double-tap-timeline@opencode2
# Check all configured plugins without updating them
opencode2 plugin check
```

To install an update, run `opencode2 plugin update` with the configured target as its argument.
Omitting the target updates all configured mutable plugin targets. `check` only reports available
updates. Restarting OpenCode is not an upgrade; exact pins remain fixed.

Do not overwrite a shared V1 configuration with these V2 examples or add a V2-only entry to a
V1 singular `plugin` list. V1 and V2 may share the default `~/.config/opencode/` directory, so
choose a separate configuration root for a side-by-side trial. `OPENCODE_CONFIG_DIR` selects that
root; a fully isolated trial also needs separate home, data, state, and cache locations. These
examples do not migrate existing configuration or session data.

### Updating V1 installations

V1 reuses the cached installation for an already configured target; a restart alone does not fetch
a newer package. To move an actively maintained V1 plugin to another release, choose a different
exact version and use `opencode plugin --force <package>@<version>` to replace the configured
entry. `--force` changes configuration; it does **not** refresh the cache for the same `@latest`
specifier. The loader and timeline V1 lines are frozen and need no further V1 upgrade.

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

This project is a monorepo managed with Bun and Turborepo. The canonical toolchain uses Bun
**1.3.12**.

```bash
# Install dependencies
bun install --frozen-lockfile

# Build all plugins before local-entrypoint or artifact checks
bun run build

# Run the canonical Turbo test pipeline
bun run test

# Typecheck and lint the workspace
bun run typecheck
bun run lint
```

Do not use bare `bun test` from the repository root as the canonical check; `bun run test` is
the Turbo pipeline and includes the root release guard. A package-scoped `bun test` is valid when
run from that package directory. `bun run check` runs Biome with `--write`, so it mutates files and
should only be used when formatting changes are intended.

Read the [documentation index](./docs/README.md), [V1 plugin guide](./docs/v1-plugins.md), and
[contribution guidelines](./CONTRIBUTING.md) before contributing.

## Disclaimer

This project is not affiliated with the anomalyco/opencode team in any way. These plugins are independently developed and maintained. I do this for the love of the game ¯\\_(ツ)_/¯

## License

[MPL-2.0](./LICENSE.txt)
