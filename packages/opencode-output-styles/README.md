# @capybearista/opencode-output-styles

Output styles plugin for OpenCode

[![NPM Version](https://img.shields.io/npm/v/@capybearista/opencode-output-styles)](https://www.npmjs.com/package/@capybearista/opencode-output-styles)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](https://opensource.org/licenses/MPL-2.0)

## Usage

1. Create a markdown file in `~/.config/opencode/output-styles/` or `<project-root>/.opencode/output-styles/` with YAML frontmatter:
   ```yaml
   ---
   name: "Pirate Style"
   description: "Talks like a pirate"
   keep-coding-instructions: false
   ---
   # Pirate
   You must respond like a swashbuckling pirate.
   ```
2. In OpenCode, run `/style <filename>` (e.g. `/style pirate`) to activate the style.
3. OpenCode will now inject this style into the system prompt and (if `keep-coding-instructions: false`) mute default coding instructions.
4. Use `/style` to list available styles or `/style clear` to remove the active style.

## Install

```bash
opencode plugin install @capybearista/opencode-output-styles
```

## Development

```bash
bun install        # Install dependencies
bun run check      # Lint and format
bun run typecheck  # Type check
bun test           # Run tests
bun run build      # Compile
```

## License

[MPL-2.0](LICENSE.md)
