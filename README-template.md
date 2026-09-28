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

> [Why this plugin exists and what it achives...]

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
Some plugins, like `opencode-ram-monitor`, will be special cases where one component (Server / TUI) is not required and only adds/enables specific features. As such, they may not strictly adhere to the cases below.
</NOTE>

### OpenCode V2

<server|TUI>
This plugin has only a [Server|TUI] component.

Add it under the `"plugins"` key in [`opencode.json(c)`|`cli.json`]:

```json
{
  "plugins": ["@capybearista/opencode-<plugin-name>@latest"]
}
```

[TUI|Server] entry only, so [`cli.json`|`opencode.json(c)`] needs no entry.
</server|TUI>

<server+TUI>
This plugin has a Server component + TUI component.

Add it under the `"plugins"` key in `opencode.json(c)`:

```json
{
  "plugins": ["@capybearista/opencode-<plugin-name>@latest"]
}
```

**AND**

Add it under the `"plugins"` key in `cli.json`:

```json
{
  "plugins": ["@capybearista/opencode-<plugin-name>@latest"]
}
```
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

<optional>

## Category 1

...

## Category 2

...
</optional>

## Troubleshooting

- [...]

<optional>

## Development Notes

...
</optional>

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
