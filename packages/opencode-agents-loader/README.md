# opencode-agents-loader

<p align="center">Extend V2 agent and command discovery to the .agents/ directory standard</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agents-loader"><img alt="npm version" src="https://img.shields.io/npm/v/@capybearista/opencode-agents-loader?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agents-loader"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@capybearista/opencode-agents-loader?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Why?

> The `.agents/` directory is becoming an open standard for agent-based tools. This plugin lets OpenCode read **commands** and **agents** from `~/.agents/` and `.agents/` directories, enabling interoperability with other harnesses and cleaner project organization.

## Philosophy: Extending OpenCode

OpenCode is designed to be highly extensible. This plugin expands the "Agents" standard.

### Architecture

```text
src/index.ts
    └── starts the command and agent bridges

command-bridge.ts
    ├── links .agents/ command and agent files into native .opencode/ directories
    ├── records link ownership in manifests and locks
    └── watches the sources for changes

agent-source.ts
    └── validates agent frontmatter before an agent link is created
```

OpenCode natively reads from `.opencode/` and configuration files. This plugin links `.agents/`
command and agent files into the matching native directories with managed relative symlinks, so
OpenCode discovers and runs them as if they lived in `.opencode/`. It only extends discovery:
source files are never copied or rewritten, and native files and explicit config entries always
win.

## Features

- **Discovery**: finds command and agent markdown files in `~/.agents/` and `.agents/` directories.
- **Managed symlinks**: materializes relative symlinks so native OpenCode owns parsing and execution.
- **Native precedence**: respects existing native files and explicit config entries — plugin entries never overwrite native config.
- **Automatic startup**: starts both native bridges automatically; no manual sync step is required.
- **Byte preservation**: preserves complete command and agent source bytes and nested relative names by symlink, including shell and subagent templates.
- **Global destination**: uses `OPENCODE_CONFIG_DIR` for the global native destination; global sources remain in `~/.agents/`.

## Install

### OpenCode V2

Requires OpenCode **2.0.2** or later. Add it under the `"plugins"` key in `opencode.json(c)`:

```json
{
  "plugins": ["@capybearista/opencode-agents-loader@latest"]
}
```

Server entry only, so `cli.json` needs no entry.

### OpenCode V1

Add it under the `"plugin"` key in `opencode.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-agents-loader@1.0.0"]
}
```

Server entry only, so `tui.json(c)` needs no entry.

See the [V1 plugin guide](../../docs/v1-plugins.md) for details.

### Uninstall

Remove the plugin from `"plugin(s)"` from the respective config files they were added to. 

## Usage

Create markdown files with YAML frontmatter:

```md
---
description: "Does something useful"
---

# Command Body
This is the command content that the agent will process.
```

### Commands

Place command markdown files in `command/` or `commands/` subdirectories:

```text
~/.agents/
  commands/
    hello.md
    git/
      status.md

.agents/
  commands/
    project-specific-prompt.md
```

### Agents

Place agent markdown files in `agent/` or `agents/` subdirectories:

```text
~/.agents/
  agents/
    reviewer.md
    architect.md

.agents/
  agents/
    project-expert.md
```

Only `agent/` and `agents/` are plugin source directories. `mode/` and `modes/` remain native
OpenCode aliases and are not treated as new plugin agent sources; a native mode with the same name
still reserves that name. A source agent's declared `mode` is preserved, including `subagent`; the
bridge never infers or forces `primary`.

### How it works

Setup links `.agents/` files into the matching native `.opencode/` directories with managed
relative symlinks: each project scope maps into its own scope, and global `~/.agents/` maps into
the global native root. Native OpenCode owns parsing, precedence, and execution; source files are
never copied or rewritten, and destination directories must support symlink creation (there is no
copy fallback). Native files and explicit config entries always win over bridged links; where
singular and plural source spellings both exist, the plural (`commands/`, `agents/`) wins, and
nested names stay nested. Sources with invalid metadata are skipped with a diagnostic rather than
linked. Links reconcile automatically as sources change; if an update does not appear, restart
OpenCode. Command execution itself is not emulated — `$ARGUMENTS`, shell blocks, and `subagent`
behavior stay native. Bridge internals (manifests, locks, polling) are documented for contributors in [AGENTS.md](./AGENTS.md#bridge-internals).

## Configuration

There are no plugin-specific settings. After registering the plugin in the V2 server profile, it
reads the documented `.agents/` directories automatically. Keep the V2 profile separate from any
V1 configuration as described in [Install](#install).

## Troubleshooting

- If commands or agents don't appear, verify your files end in `.md` and include valid YAML frontmatter
- Confirm the directory naming is `commands/` or `command/`, `agents/` or `agent/`
- Inspect the scoped `.agents-loader/{commands,agents}-manifest.json` and diagnostics before removing
  anything; unowned native files are intentionally preserved
- If synchronization stops after a crash, inspect `.agents-loader/agents.lock` and
  `.agents-loader/commands.lock`. The bridge deliberately fails closed on held locks,
  including abandoned ones. Stop **all** OpenCode processes using that config directory
  before moving lock files aside for recovery; never remove a lock while a process might
  be reconciling. Preserve the manifests, then restart OpenCode.
- An active plugin does not guarantee every scope reconciled. Unsafe scopes emit
  diagnostic errors; when safe reconciliation resumes, the bridge reports that pending
  cleanup may remain. This message does not mean all stale links have been removed.

## Contributing

This package lives in the `opencode-plugins` monorepo. See the [contribution guidelines](../../CONTRIBUTING.md) for setup, the full check suite, and releases, and open or find an issue before a pull request.

From this directory, `bun test` runs the package tests. To try a change in your own OpenCode, see [Testing in OpenCode](../../CONTRIBUTING.md#testing-in-opencode).

## License

[MPL-2.0](./LICENSE.txt)
