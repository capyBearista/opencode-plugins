# @capybearista/opencode-agents-loader

An [OpenCode](https://opencode.ai) plugin that extends command and agent discovery to `~/.agents/` and `.agents/` directories.

## Why?

While OpenCode natively uses `.opencode/` for its configuration, the `.agents/` directory is becoming an open standard for agent-based tools. This plugin's primary intention is to support this convention, enabling better interoperability between OpenCode and other harnesses, especially if...
- you want to commit project-specific agent capabilities for other contributors to make use of
- you yourself use other harnesses (that aren't named "Claude Code", though you could symlink `.agents/<commands|agents>/` and `.claude/<commands|agents>/`)

It is also useful if you want to keep your OpenCode config separate from your custom commands and agents, or if you want to share agents across multiple projects via a global `~/.agents/` directory.

## Installation

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["@capybearista/opencode-agents-loader"]
}
```

## Directory Layout

### Commands

Place command markdown files in `command/` or `commands/` subdirectories:

```
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

```
~/.agents/
  agents/
    reviewer.md
    architect.md

.agents/
  agents/
    project-expert.md
```

## File Format

Both commands and agents use markdown files with YAML frontmatter. Find the specifics at the official OpenCode docs:
- Commands: https://opencode.ai/docs/commands/#markdown
- Agents: https://opencode.ai/docs/agents/#markdown

## Precedence

Existing config entries from `.opencode/` directories always take precedence over `.agents/` entries. The plugin only injects entries that **do not already exist**.

Within `.agents/` directories, the closest directory to your project wins. The precedence order (highest to lowest):

1. `.opencode/` directory (project-local)
2. `.agents/` directory (closest to project root)
3. `.agents/` parent directories (walking up the tree)
4. `~/.config/opencode/` directory (global)
5. `~/.agents/` directory (global)

## Requirements

- OpenCode >= 1.14.25

## License

MPL-2.0
