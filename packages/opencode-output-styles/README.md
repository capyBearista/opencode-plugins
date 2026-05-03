# @capybearista/opencode-output-styles

<p align="center">Reusable response styles for OpenCode sessions</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-output-styles"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-output-styles?style=flat-square&logo=npm" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-output-styles"><img alt="npm" src="https://img.shields.io/npm/d18m/@capybearista/opencode-output-styles?style=flat-square&logo=npm" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-blue?style=flat-square" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square" /></a>
</p>

---

## Why?

> I often find myself telling my agent to adopt an explanatory style or focus on teaching rather than implementing. I really needed a way to add persistent voice, review stance, or response structure without re-prompting every turn. This plugin keeps a chosen style active and appends it to the system prompt so response formatting stays consistent across the session.

## Philosophy: Extending OpenCode

OpenCode is designed to be extensible through plugins. This plugin takes the narrowest useful path: it does not rewrite the base OpenCode prompt, and it does not try to change model behavior outside the style block. It simply discovers styles, persists the active selection, and injects the chosen style wrapped in `<output-style>` tags into the system prompt.

### Architecture

```text
src/
├── index.ts           # Plugin hooks (thin barrel)
├── styles.ts          # Style parsing, discovery, built-in loading
└── built-in-styles/   # Shipped output styles
    ├── explanatory.md
    └── learning.md
```

## Features

- Ships built-in styles inspired by Claude Code (`explanatory`, `learning`) out of the box
- Discovers global styles from `~/.config/opencode/output-styles/`
- Discovers project-local styles from `.opencode/output-styles/`
- Activates styles with `/output-style <id>`
- Persists the active style in `.opencode/active-style.json`
- Injects the selected style wrapped in `<output-style>` tags into the system prompt
- Marks built-in styles with `[Built-in]` in the style listing
- Supports overriding: user styles take precedence over built-in styles with the same id

## Install

Add the plugin to `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@capybearista/opencode-output-styles"]
}
```

You can also install it through the CLI:

```bash
opencode plugin -g    # global install
opencode plugin       # project-local install
```

## Usage

### Built-in styles

The plugin ships with two built-in styles that are available immediately:

| Id | Name | Description |
| --- | --- | --- |
| `explanatory` | explanatory | Provides educational insights while helping with tasks |
| `learning` | learning | Interactive learning mode for CS students |

Use them like any other style:

```text
/output-style explanatory
/output-style learning
```

### Custom styles

Create a markdown file in `~/.config/opencode/output-styles/` or `<project-root>/.opencode/output-styles/` with YAML frontmatter:

```md
---
name: "Pirate"
description: "Talks like a pirate"
---
# Pirate
You must respond like a swashbuckling pirate.
```

### Overriding built-in styles

To replace a built-in style with your own version, create a markdown file with the **same id** (same filename without `.md`) in one of the user style directories. Your version takes precedence over the built-in.

For example, to override `explanatory` with a custom version, create `~/.config/opencode/output-styles/explanatory.md` or `<project-root>/.opencode/output-styles/explanatory.md`.

### Commands

| Command | Description |
| --- | --- |
| `/output-style` | Lists all available styles (built-in and user) |
| `/output-style <id>` | Activates the specified style |
| `/output-style clear` | Removes the active style |

## Configuration

Style files support the following frontmatter:

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Display name shown in the `/output-style` list. Defaults to the filename. |
| `description` | `string` | Short summary shown in the `/output-style` list. Defaults to empty. |

The active style's body is wrapped in `<output-style>` tags and appended to the system prompt:

```text
<output-style>
...style body...
</output-style>
```

The plugin also writes one project-local state file:

| File | Purpose |
| --- | --- |
| `.opencode/active-style.json` | Stores the currently selected style id for the project. |

## Troubleshooting

- If `/output-style` shows no results, confirm your style files end in `.md` and include YAML frontmatter.
- If two styles share the same filename, the project-local version takes precedence over the global one, which takes precedence over the built-in.
- The `/output-style` command currently uses a plugin API workaround that throws a handled error to short-circuit the command pipeline, because the plugin API does not yet expose a clean command short-circuit path.

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on style discovery, persistence, and prompt appending.
- Prefer small, direct changes over expanding the plugin into broader prompt-rewriting behavior.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](LICENSE.md)
