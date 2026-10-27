# opencode-<plugin-name>

<p align="center">One-liner describing the plugin</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-<plugin-name>"><img alt="npm version" src="https://img.shields.io/npm/v/@capybearista/opencode-<plugin-name>?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-<plugin-name>"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@capybearista/opencode-<plugin-name>?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Why?

> [Why this plugin exists and what it achieves...]

## Philosophy: Extending OpenCode

OpenCode is designed to be highly extensible. This plugin [...].

### Architecture

```mermaid
[KEEP DIAGRAM SIMPLE]
```

[Brief elaboration...]

## Features

- **[Feature 1]**: ...
- **[Feature 2]**: ...
- **[Feature 3]**: ...
- [more bullets optional]: ...

## Install

<NOTE>
Some plugins will be special cases where one component (Server / TUI) is not required and only adds/enables specific features. As such, they may not strictly adhere to the cases below.
</NOTE>

### OpenCode V2

Requires OpenCode **<2.x.y>** or later. [Use the lowest version the package's `@opencode/plugin` peer range allows.]

<server|TUI>
This plugin has only a [Server|TUI] component.

Add it under the `"plugins"` key in [`opencode.json(c)`|`cli.json`]:

```json
{
  "plugins": ["@capybearista/opencode-<plugin-name>@latest"]
}
```

> [!IMPORTANT]
> This plugin is [TUI|Server]-only, so it belongs in [`cli.json`|`opencode.json(c)`].
</server|TUI>

<server+TUI>
This plugin has a Server component + TUI component.

Add one entry under the `"plugins"` key in `opencode.json(c)`:

```json
{
  "plugins": ["@capybearista/opencode-<plugin-name>@latest"]
}
```

The TUI half loads automatically, so `cli.json` needs no entry.
</server+TUI>

### OpenCode V1

<server|TUI>
This plugin has only a [Server|TUI] component.

Add it under the `"plugin"` key in [`opencode.json(c)`|`tui.json(c)`]:

```json
{
  "plugin": ["@capybearista/opencode-<plugin-name>@1.x.x"]
}
```

[TUI|Server] entry only, so [`tui.json(c)`|`opencode.json(c)`] needs no entry.
</server|TUI>

<server+TUI>
This plugin has a Server component + TUI component.

Add it under the `"plugin"` key in `opencode.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-<plugin-name>@1.x.x"]
}
```

**AND**

Add it under the `"plugin"` key in `tui.json(c)`:

```json
{
  "plugin": ["@capybearista/opencode-<plugin-name>@1.x.x"]
}
```
</server+TUI>

See the [V1 plugin guide](../../docs/v1-plugins.md) for details.

### Uninstall

Remove the plugin from `"plugin(s)"` from the respective config files they were added to. [extra instructions if the plugin creates other artifacts on disk]

## Usage

[...]

## Configuration

[...]

<V2 options>
Pass options in the plugin's entry, using the object form:

```json
{
  "plugins": [
    {
      "package": "@capybearista/opencode-<plugin-name>@latest",
      "options": { "<option>": "<value>" }
    }
  ]
}
```

> [!WARNING]
> Use the object form above. The V1 tuple form (`["@capybearista/opencode-<plugin-name>", { ... }]`) is not valid in V2, and in `cli.json` one invalid entry makes OpenCode ignore the whole file, including your theme, keybinds, and every other plugin.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `<option>` | `<type>` | `<default>` | [...] |
</V2 options>

<optional>

## Category 1

...

## Category 2

...
</optional>

## Troubleshooting

- [...]

[Keep the README for users. Internals, verification notes and test details go in the package's AGENTS.md or `docs/<plugin-name>/`.]

## Contributing

This package lives in the `opencode-plugins` monorepo. See the [contribution guidelines](../../CONTRIBUTING.md) for setup, the full check suite, and releases, and open or find an issue before a pull request.

From this directory, `bun test` runs the package tests[ and `bun run smoke` checks the built package]. To try a change in your own OpenCode, see [Testing in OpenCode](../../CONTRIBUTING.md#testing-in-opencode).

## License

[MPL-2.0](./LICENSE.txt)
