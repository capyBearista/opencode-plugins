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

OpenCode is designed to be extensible through plugins. This plugin takes the narrowest useful path: it does not rewrite the base OpenCode prompt, and it does not try to change model behavior outside the style block. It simply discovers styles, persists the active selection, and appends the chosen style instructions to the system prompt.

### Architecture

```text
src/
└── index.ts
    ├── parseStyleFile()
    ├── discoverStyles()
    ├── command.execute.before
    └── experimental.chat.system.transform
```

## Features

- Discovers global styles from `~/.config/opencode/output-styles/`
- Discovers project-local styles from `.opencode/output-styles/`
- Activates styles with `/style <id>`
- Persists the active style in `.opencode/active-style.json`
- Appends the selected style as an `# Output Style` block on each request
- Lets project-local styles override global styles with the same id

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

Create a markdown file in `~/.config/opencode/output-styles/` or `<project-root>/.opencode/output-styles/` with YAML frontmatter:

```md
---
name: "Pirate"
description: "Talks like a pirate"
---
# Pirate
You must respond like a swashbuckling pirate.
```

Then use:

```text
/style pirate
```

Other commands:

- `/style` lists available styles
- `/style clear` removes the active style

## Configuration

Style files support the following frontmatter:

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Display name shown in the `/style` list. Defaults to the filename. |
| `description` | `string` | Short summary shown in the `/style` list. Defaults to empty. |

The plugin also writes one project-local state file:

| File | Purpose |
| --- | --- |
| `.opencode/active-style.json` | Stores the currently selected style id for the project. |

## Troubleshooting

- If `/style` shows no results, confirm your style files end in `.md` and include YAML frontmatter.
- If two styles share the same filename, the project-local version takes precedence over the global one.
- The `/style` command currently uses a plugin API workaround that asks the model to echo the command result, because the plugin API does not yet expose a clean command short-circuit path.

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on style discovery, persistence, and prompt appending.
- Prefer small, direct changes over expanding the plugin into broader prompt-rewriting behavior.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](LICENSE.md)
