# opencode-output-styles

<p align="center">Reusable response styles for OpenCode sessions</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-output-styles"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-output-styles?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-output-styles"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-output-styles?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

> [!IMPORTANT] V2
> A V2 port is not planned at this time. The V1 output-style capability remains enabled.

## Why?

> I often find myself telling my agent to adopt an explanatory style or focus on teaching rather than implementing. I really needed a way to add persistent voice, review stance, or response structure without re-prompting every turn. This plugin keeps a chosen style active and appends it to the system prompt so response formatting stays consistent across the session.

## Philosophy: Extending OpenCode

OpenCode is designed to be extensible through plugins. This plugin takes the narrowest useful path: it does not rewrite the base OpenCode prompt, and it does not try to change model behavior outside the style block. It simply discovers styles, persists the active selection, and injects the chosen style wrapped in `<output-style>` tags into the system prompt.

### Architecture

```text
src/
├── index.ts           # Plugin entry point
├── styles.ts          # Style parsing, discovery, built-in loading
└── built-in-styles/   # Shipped output styles
    ├── explanatory.md
    └── learning.md
```

## Features

- **Built-in styles**: ships `explanatory` and `learning`, *inspired* by Claude Code.
- **Global discovery**: reads styles from `~/.config/opencode/output-styles/`.
- **Project-local discovery**: reads styles from `.opencode/output-styles/`.
- **Activation**: switches the active style with `/output-style <id>`.
- **Persistence**: keeps the active style in `.opencode/active-style.json`.
- **Prompt injection**: injects the selected style, wrapped in `<output-style>` tags, into the system prompt.
- **Built-in labeling**: marks built-in styles with `[Built-in]` in the style listing.
- **Overriding**: user styles take precedence over built-in styles with the same id.

## Install

### OpenCode V1

Add it under the `"plugin"` key in `opencode.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-output-styles@1.0.1"]
}
```

Server entry only, so `tui.json(c)` needs no entry.

See the [V1 plugin guide](../../docs/v1-plugins.md) for details.

### Uninstall

Remove the plugin from `"plugin(s)"` from the respective config files they were added to.

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

### Contract

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

## Configuration

This plugin requires no manual configuration.

## Troubleshooting

- If `/output-style` shows no results, confirm your style files end in `.md` and include YAML frontmatter.
- If two styles share the same filename, the project-local version takes precedence over the global one, which takes precedence over the built-in.
- The `/output-style` command is handled by the plugin directly; there is no command file to edit.

## Contributing

This package lives in the `opencode-plugins` monorepo.

See the [contribution guidelines](../../CONTRIBUTING.md) before opening a pull request.

- From the monorepo root, run `bun run build` before artifact checks, then `bun run typecheck`,`bun run lint`, and the canonical `bun run test` Turbo pipeline. Do not use bare root `bun test` as the workspace check.
- For a focused run, `bun test` is supported from this package directory; its tests include the real local-directory resolver regression.
- `bun run check` writes Biome changes; use it only when formatting changes are intended.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](./LICENSE.txt)
