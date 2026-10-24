 <p align="center">
  <img src=".github/assets/capybearista-wordmark.svg" alt="capyBearista" width="220">
</p>

<h1 align="center">
  <picture>
    <source srcset=".github/assets/opencode-plugins-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset=".github/assets/opencode-plugins-light.svg" media="(prefers-color-scheme: light)">
    <img src=".github/assets/opencode-plugins-light.svg" alt="OpenCode Plugins" width="480">
  </picture>
</h1>

<p align="center">
  <strong>Small upgrades to how you use OpenCode.</strong>
</p>

<p align="center">
  Independent plugins for code reviews, live RAM monitoring, faster navigation, reusable agent configurations, and more!
</p>

<p align="center">
  <a href="https://www.npmjs.com/~capybearista"><img alt="npm downloads" src="https://img.shields.io/endpoint?url=https://dry-haze-b628.capybearista.workers.dev&style=flat-square&color=%236067e6"></a>
  <a href="https://opencode.ai"><img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-Plugins-60a5e6?style=flat-square"></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="License" src="https://img.shields.io/badge/License-MPL--2.0-60dfe6?style=flat-square"></a>
  <a href="https://github.com/capybearista/opencode-plugins/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/capybearista/opencode-plugins/ci.yml?style=flat-square&branch=main&label=CI"></a>
  <a href="https://deepwiki.com/capyBearista/opencode-plugins"><img src=".github/assets/deepwiki.svg" alt="Ask DeepWiki"></a>
</p>

<p align="center">
  <a href="#meet-the-plugins">Explore Plugins</a> ·
  <a href="#quick-start-opencode-v2">Quick Start</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

Every plugin in this repository addresses a specific friction point in OpenCode, whether that's navigating sessions, understanding resource usage, or improving how agents work.

**No bundle required.** Each plugin is independently published and installable. Pick the ones that improve your workflow.

## Meet the Plugins

### OpenCode V2

#### 🐏 [RAM Monitor](./packages/opencode-ram-monitor/)

**See where OpenCode's memory goes.**

A live sidebar widget shows memory usage split between OpenCode itself and the tools it runs, including MCP servers, language servers, and terminal processes.

- **Live visibility:** Monitor memory usage without leaving OpenCode.
- **Detailed inspection:** Click the widget or use `/ram` to inspect the process tree.
- **Lightweight:** No additional dependencies, with full and minimal sidebar layouts.

*OpenCode V2.1+ · TUI plugin*

<p align="center">
  <a href="./packages/opencode-ram-monitor/">
    <img src=".github/assets/ram-monitor-sidebar.webp" alt="RAM Monitor showing OpenCode and tool memory usage in the sidebar" width="560">
  </a>
</p>

#### ⏱️ [Double-Tap Timeline](./packages/opencode-double-tap-timeline/)

**Navigate your session without reaching for a command.**

Inspired by Claude Code's double-Escape interaction. Double-tap `Esc` to open OpenCode's session timeline instantly, without typing `/timeline` or using the mouse.

- **Instant access:** Two quick Escape presses open the timeline.
- **Native behavior preserved:** A single Escape continues to work normally.
- **No configuration:** Install the plugin and use the shortcut.

*OpenCode V2 · TUI plugin*

<p align="center">
  <a href="./packages/opencode-double-tap-timeline/">
    <img src=".github/assets/timeline-TUI.png" alt="OpenCode session timeline modal" width="560">
  </a>
</p>

#### 🤺 [Adversarial Review](./packages/opencode-adversarial-review/)

**Challenge your code before shipping it.**

Two clean-context reviewers examine your code independently of the conversation that produced it:

- **`/adversarial-review`** — Challenges implementation decisions and looks for reasons not to ship, prioritizing correctness, security, and data-loss risks.
- **`/constructive-review`** — Reviews correctness and provides actionable improvements.

Both reviewers gather their own evidence, support working-tree changes, commits, branches, and pull requests, and produce structured findings.

*Inspired by Codex · OpenCode V2 · Server plugin*

#### 🛠️ [Agents Loader](./packages/opencode-agents-loader/)

**Keep your agents and commands portable.**

Extend OpenCode's agent and command discovery to the `.agents/` directory convention, allowing configurations to be shared across compatible AI coding tools.

- **Global and project-local:** Discover files in `~/.agents/` and `.agents/`.
- **Native integration:** Managed symlinks expose files to OpenCode without rewriting their contents.
- **Automatic synchronization:** Changes are reconciled while preserving native OpenCode configuration precedence.

*OpenCode V2 · Server plugin*

### OpenCode V1

These plugins remain available for OpenCode V1 but have not been ported to V2.

#### 💬 [Agent Prompt Inheritance](./packages/opencode-agent-prompt-inheritance/)

**Keep base model instructions when customizing agents.**

Custom agent prompts can replace provider-specific system instructions. This plugin allows agents to inherit supported provider prompts while adding their own task-specific guidance.

Supports configurable prompt ordering through agent frontmatter.

*OpenCode V1 only · V2 port TBD*

#### 🗣️ [Output Styles](./packages/opencode-output-styles/)

**Choose how your agent responds, and keep it that way.**

Switch between persistent response styles without repeating the same instructions throughout a conversation.

Includes built-in `explanatory` and `learning` styles, with support for custom project-local and global styles.

*Inspired by Claude Code · OpenCode V1 only · No V2 port planned*

## Quick Start (OpenCode V2)

Install only the plugins you want by adding their npm packages to your OpenCode configuration.

OpenCode V2 separates **server plugins** from **TUI plugins**. They use different configuration files.

### 1. Server plugins

Add your selected server plugins to `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@capybearista/opencode-adversarial-review@latest",
    "@capybearista/opencode-agents-loader@latest"
  ]
}
```

These plugins extend OpenCode's agent, command, and review functionality.

**Adversarial Review setup:** The target `commands/` directory must already exist and be writable before enabling the plugin. The plugin installs its two review command files there. See the [package installation guide](./packages/opencode-adversarial-review/#install).

### 2. TUI plugins

Add your selected TUI plugins to your global `cli.json`, typically at `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "@capybearista/opencode-double-tap-timeline@latest",
    "@capybearista/opencode-ram-monitor@latest"
  ]
}
```

These plugins extend OpenCode's terminal interface.

> [!IMPORTANT]
> RAM Monitor requires **OpenCode 2.1 or later**. Both TUI plugins belong in `cli.json`, not `opencode.json`.

**That's it.** Remove any plugin entries you don't want. Each package can be installed independently.

For plugin-specific options, usage examples, and troubleshooting, follow the links in [Meet the Plugins](#meet-the-plugins).

## Compatibility

The repository supports both OpenCode V2 and V1, but plugin availability and configuration differ between versions.

| Plugin | OpenCode V2 | OpenCode V1 |
| --- | --- | --- |
| [Adversarial Review](./packages/opencode-adversarial-review/) | `@latest` · `opencode.json(c)` | `@1.0.0` · `opencode.json(c)` |
| [Agents Loader](./packages/opencode-agents-loader/) | `@latest` · `opencode.json(c)` | `@1.0.0` · `opencode.json(c)` |
| [Double-Tap Timeline](./packages/opencode-double-tap-timeline/) | `@latest` · `cli.json` | `@1.0.1` · `tui.json(c)` |
| [RAM Monitor](./packages/opencode-ram-monitor/) | `@latest` · `cli.json` (2.1+) | `@1.1.0` · `opencode.json(c)` and `tui.json(c)` |
| [Agent Prompt Inheritance](./packages/opencode-agent-prompt-inheritance/) | Not yet ported | `@1.0.0` · `opencode.json(c)` |
| [Output Styles](./packages/opencode-output-styles/) | Not planned | `@1.0.1` · `opencode.json(c)` |

**Using OpenCode V1?** See the [V1 Plugin Guide](./docs/v1-plugins.md) for installation, version pinning, and upgrade instructions.

### Updating plugins

OpenCode V2 provides both a built-in TUI plugin manager and CLI commands for managing updates.

**Through the TUI:** Open the plugins dialog through the footer or the "Open plugins" action. From there, you can check for updates, update plugins, and inspect their status.

[View the TUI plugin manager](.github/assets/plugin-management-TUI.png)

**Through the CLI:**

```bash
# Check for available updates
opencode plugin check

# Update all configured mutable targets
opencode plugin update

# Update a specific plugin
opencode plugin update @capybearista/opencode-ram-monitor
```

Only mutable package targets, such as `@latest`, receive updates. Exact version pins remain unchanged.

For V1 upgrades and cache behavior, see the [V1 Plugin Guide](./docs/v1-plugins.md).

## What Should I Build Next?

Every plugin here started because I hit a wall with stock OpenCode and thought _"there's gotta be a better way."_

I usually browse through [Reddit](https://reddit.com/r/opencodecli) and the GitHub Issues section of the [OpenCode](https://github.com/anomalyco/opencode) repo, noticing people griping about their workflows. But if you've got a concrete idea and want to put it directly in front of me, I'm all ears :)

<span>&#8611;</span> Got a brand-new plugin idea? [Open a plugin proposal issue](https://github.com/capybearista/opencode-plugins/issues/new?template=new_plugin_proposal.yml).

<span>&#8611;</span> Already using a plugin and something's off? Or maybe you've got an idea to enhance an existing plugin or the monorepo itself? [Open a feature request issue](https://github.com/capybearista/opencode-plugins/issues/new?template=feature_request.yml).
If these plugins have made your workflow better, consider starring the repository. It helps other OpenCode users discover the project.

## Shoutouts

Plugins I've personally used and highly recommend! Some of these are genuinely underrated and have massive potential.

| Name                                                                             | Use case                                                         | Description                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [opencode-quota](https://github.com/slkiser/opencode-quota)                      | Keep track of your provider subscriptions _in_ OpenCode          | Token usage and quota tracking for Anthropic, OpenAI, Copilot, and more—reports in terminal with zero context pollution.                                                           |
| [opencode-snippets](https://github.com/JosXa/opencode-snippets)                  | Expand `#tags` into text anywhere, instantly                     | Hashtag-based snippet expansion. Just type `#name` to inject pre-defined code blocks, configs, or prompts inline. You can even put them in commands.                               |
| [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) | Caps token waste from stale context                              | Context-aware compression intelligently prunes old tool outputs to keep context lean and reduce token burn.                                                                        |
| [cc-safety-net](https://github.com/kenryu42/claude-code-safety-net)              | Prevents dangerous commands like `rm -rf` and `git reset --hard` | Intercepts destructive git and filesystem commands before they execute, giving you a chance to abort before your agent deletes your entire project.                                |
| [opencode-agent-identity](https://github.com/gotgenes/opencode-agent-identity)   | Distinguish which sub-agent said what in multi-agent sessions    | Per-message attribution so each agent knows its role and which message came from which source.                                                                                     |

## Contributing

Contributions, bug reports, and suggestions are welcome.

Before opening a pull request, see [CONTRIBUTING.md](./CONTRIBUTING.md) and the [documentation index](./docs/README.md).

### Development

This repository is a monorepo managed with **Bun** and **Turborepo**. The canonical toolchain uses Bun **1.3.12**.

```bash
# Install dependencies
bun install --frozen-lockfile

# Build packages
bun run build

# Run tests, typechecks, and linting
bun run test
bun run typecheck
bun run lint
```

Use `bun run test` for the canonical root test pipeline rather than invoking `bun test` directly from the repository root.

For package-specific development, release checks, and contribution conventions, consult the [contribution guidelines](./CONTRIBUTING.md).

## License

Distributed under the [Mozilla Public License 2.0](./LICENSE.txt).

This project is independently developed and maintained. It is **not affiliated with the OpenCode team**.

Made for the love of the game ¯\\_(ツ)_/¯
