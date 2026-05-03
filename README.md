<p align="center">
  <a href="https://github.com/capybearista/opencode-plugins">
    <picture>
      <source srcset=".github/assets/opencode-plugins-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/opencode-plugins-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/opencode-plugins-light.svg" alt="OpenCode Plugins logo">
    </picture>
  </a>
</p>

# OpenCode Plugins by capyBearista

A collection of plugins for the OpenCode AI coding agent. These extensions add quality-of-life improvements, user interface features, and new configuration standards.

## The Plugins

### @capybearista/opencode-output-styles
Persistent response styles for OpenCode sessions. This plugin injects selected guidelines (like "explanatory" or "learning" modes) into the system prompt so they stay active across your session.

### @capybearista/opencode-agents-loader
Extends command and agent discovery to the `.agents/` directory standard. This enables interoperability with other AI tools and keeps project configuration organized.

### @capybearista/opencode-double-tap-timeline
A keyboard-driven UI extension. Double-tap the Escape key to instantly open the session timeline modal without typing commands or using a mouse. ⌨️

## Installation

You can install any of these plugins globally or locally using the OpenCode CLI:

```bash
opencode plugin add -g @capybearista/opencode-output-styles
```

Alternatively, add them directly to your `opencode.json` configuration file:

```json
{
  "plugin": [
    "@capybearista/opencode-output-styles",
    "@capybearista/opencode-agents-loader"
  ]
}
```

## Development

This project is a monorepo managed with Bun and Turborepo.

```bash
# Install dependencies
bun install

# Build all plugins
bun run build

# Run tests
bun run test
```

## Creating a New Plugin

We use a standard template for new plugins. 

1. Run the scaffolding skill:
   `init-plugin`
2. Follow the prompts to generate the package.
3. Build and test locally.

## License

MPL-2.0
