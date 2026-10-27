# opencode-output-styles

<p align="center">Claude Code-style output styles for OpenCode sessions</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-output-styles"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-output-styles?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-output-styles"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-output-styles?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Why?

> I often find myself telling my agent to adopt an explanatory style or focus on teaching rather than implementing. I really needed a way to add persistent voice, review stance, or response structure without re-prompting every turn. This plugin keeps a chosen style active for the whole session, the way [Claude Code's output styles](https://code.claude.com/docs/en/output-styles) do.

## Philosophy: Extending OpenCode

An output style is a set of instructions that applies to every response in a session. The plugin adds the style next to OpenCode's own prompt and never edits either OpenCode's prompt or an agent's own prompt.

- **Durable:** the style is attached to the session as an OpenCode instruction entry. It applies to every model request, including the steps after tool calls, and survives compaction.
- **Cache-friendly:** switching styles never rewrites anything the model has already seen. OpenCode adds a short update at the point of the switch, so the cached part of the conversation is reused.
- **Reminded:** each of your messages carries a short `<system-reminder>` naming the style that was active when you sent it. Messages sent with no style carry none.
- **Primary agents only:** subagents run their own prompts and get no style, as in Claude Code.

### Architecture

```text
src/
├── server.ts      # Server entry: RPC, instruction entry, reminders
├── tui.ts         # TUI entry: /output-style, picker, sidebar line
├── rpc.ts         # Server ↔ TUI contract
├── styles.ts      # Discovery and frontmatter parsing
└── prompt.ts      # Entry and reminder composition
built-in-styles/   # Proactive, Concise, Explanatory, Learning
```

The server owns the style files, the session choice, and the global setting. The TUI asks it over RPC, because a TUI loaded this way gets no plugin options of its own.

## Features

- **Built-in styles** from Claude Code 2.1.310: Proactive, Concise, Explanatory, Learning. `None` means no style (Claude Code calls it "Default").
- **Per-session style**, with a global setting for sessions that have not picked one.
- **`/output-style [name]`**, a picker, and a clickable `Output Style: <Name>` line in the sidebar.
- **Custom styles** from your global config dir and the project, which can override built-ins.

## Install

### OpenCode V2

Requires OpenCode **2.2.0** or later. Add one entry under `"plugins"` in `opencode.json(c)`:

```json
{
  "plugins": ["@capybearista/opencode-output-styles@latest"]
}
```

The TUI half loads automatically, so `cli.json` needs no entry. To hide the sidebar line, use the object form:

```json
{
  "plugins": [
    { "package": "@capybearista/opencode-output-styles@latest", "options": { "sidebar": false } }
  ]
}
```

### OpenCode V1

Stay on the 1.x line, which is frozen at 1.0.2:

```json
{
  "plugin": ["@capybearista/opencode-output-styles@1"]
}
```

See the [V1 plugin guide](../../docs/v1-plugins.md).

### Uninstall

Remove the entry from `"plugins"`. Session choices live in session metadata and the global setting in OpenCode's plugin storage, so nothing is left in your project.

## Usage

| Action | What it does |
| --- | --- |
| `/output-style`, "Output style" in the command palette, or click the sidebar line | Opens the picker for this session. |
| `/output-style <name>` | Applies a style to this session by id or name (case-insensitive). |
| `/output-style none` | Turns styles off for this session, even if a global style is set. Also the picker's "None" entry. |
| `/output-style global` | Clears this session's own choice so it uses the global setting again. Also the picker's "Use global" entry. |
| From the home screen | The picker, `/output-style <name>` and `/output-style none` change the global setting instead. `/output-style global` needs a session and does nothing here. |
| Subagent sessions | Get no style. While you view one, the command and picker act on its parent session. |

A switch applies from your next message.

- **Forked sessions** start on the global setting. A session's own style is not copied into a fork.
- **Several open windows:** changing the global setting in one window doesn't update another window's sidebar line until you open the picker there or restart that TUI. The model still gets the current style, because the server reads the setting on every message.

`none` and `global` are command words, so a custom style whose id or name is `none` or `global` can only be picked from the picker.

### Built-in styles

| Id | What changes |
| --- | --- |
| `proactive` | Starts work right away and makes reasonable assumptions instead of asking about routine decisions. Still checks before deleting data or touching shared or production systems. |
| `concise` | Leads with the result and leaves out preamble, narration, and recaps. |
| `explanatory` | Adds short `★ Insight` blocks explaining the choices behind the code. |
| `learning` | Adds Insights and leaves small `TODO(human)` pieces for you to write. |

### Custom styles

A style is a markdown file: frontmatter, then the instructions. Put it in either directory:

- Global: `~/.config/opencode/output-styles/` (or `$XDG_CONFIG_HOME/opencode/output-styles/`, or `$OPENCODE_CONFIG_DIR/output-styles/`)
- Project: `<project-root>/.opencode/output-styles/`

```md
---
name: Diagrams first
description: Lead every explanation with a diagram
---

When explaining code, architecture, or data flow, start with a Mermaid diagram, then explain in prose.
```

The id is the filename without `.md`. Only files directly in those directories count, and symlinked files and directories are followed. Changes apply on the next message, with no restart.

| Frontmatter | Default | Description |
| --- | --- | --- |
| `name` | filename | Shown in the picker and sidebar. |
| `description` | empty | Shown in the picker. |
| `turn-reminder` | none | Text for the per-message reminder. Without it, the reminder says "Remember to follow the specific guidelines for this style." |

### Overriding built-in styles

A file with the same id replaces the built-in completely: project over global over built-in. Fields are not merged, so to keep a built-in's reminder, copy its `turn-reminder` line into your file.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `sidebar` | `true` | Show the `Output Style: <Name>` line in the session sidebar. |

## Troubleshooting

- **No sidebar line and an "Output styles: server plugin not reachable" toast:** the package is in `cli.json` instead of `opencode.json(c)`. Move it.
- **A style does nothing:** check the file ends in `.md`, sits directly in one of the style directories, and has instructions after the frontmatter.
- **Styles do nothing on an older OpenCode:** upgrade to 2.2.0 or later. Session instruction entries are new in 2.2.0.

## Contributing

This package lives in the `opencode-plugins` monorepo. See the [contribution guidelines](../../CONTRIBUTING.md) for setup, the full check suite, and releases, and open or find an issue before a pull request.

From this directory, `bun test` runs the package tests and `bun run smoke` checks the built package. To try a change in your own OpenCode, see [Testing in OpenCode](../../CONTRIBUTING.md#testing-in-opencode). Before refreshing the built-in styles, read [the findings doc](../../docs/output-styles/v2-port-findings.md) for how they were extracted.

## License

[MPL-2.0](./LICENSE.txt)
