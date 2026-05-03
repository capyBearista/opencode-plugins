# opencode-agents-loader

<p align="center">Extend agent discovery to the .agents/ directory standard</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agents-loader"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-agents-loader?style=flat-square&logo=npm" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agents-loader"><img alt="npm" src="https://img.shields.io/npm/d18m/@capybearista/opencode-agents-loader?style=flat-square&logo=npm" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-blue?style=flat-square" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square" /></a>
</p>

---

## Why?

> The `.agents/` directory is becoming an open standard for agent-based tools. This plugin lets OpenCode read commands and agents from `~/.agents/` and `.agents/` directories, enabling interoperability with other harnesses and cleaner project organization.

## Philosophy: Extending OpenCode

OpenCode natively reads from `.opencode/` and `~/.config/opencode/`. This plugin adds `.agents/` as an additional discovery source without overwriting or conflicting with existing config. It merges discovered entries into the OpenCode configuration during session startup.

### Architecture

```text
src/index.ts
    ├── fallbackSanitization()
    ├── parseMarkdown()
    ├── scanDirectory()
    ├── findProjectDirs()
    └── config hook
        └── scans ~/.agents/ + .agents/ tree
            └── merges commands + agents into cfg
```

## Features

- Discovers command and agent markdown files from `~/.agents/` and `.agents/` directories
- Supports `command/`, `commands/`, `agent/`, and `agents/` subdirectory naming
- Respects existing `.opencode/` entries — plugin entries never overwrite native config
- Walks up the directory tree from the project root to find parent `.agents/` directories
- YAML frontmatter support for metadata in markdown files

## Install

Add the plugin to `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@capybearista/opencode-agents-loader"]
}
```

You can also install it through the CLI:

```bash
opencode plugin -g    # global install
opencode plugin       # project-local install
```

## Usage

Create markdown files with YAML frontmatter:

```md
---
name: "My Command"
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

## Configuration

This plugin requires no manual configuration. It works automatically by reading from `.agents/` directories.

### Precedence

Existing config entries from `.opencode/` directories always take precedence over `.agents/` entries. The plugin only injects entries that **do not already exist**.

Within `.agents/` directories, the closest directory to your project wins. Precedence (highest to lowest):

1. `.opencode/` (project-local)
2. `.agents/` closest to project root
3. `.agents/` parent directories (walking up the tree)
4. `~/.config/opencode/` (global)
5. `~/.agents/` (global)

## Troubleshooting

- If commands or agents don't appear, verify your files end in `.md` and include valid YAML frontmatter
- Confirm the directory naming is `commands/` or `command/`, `agents/` or `agent/`
- `.opencode/` entries always take priority — remove or rename conflicts there first

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on agent/command discovery from `.agents/` directories.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](LICENSE.md)
