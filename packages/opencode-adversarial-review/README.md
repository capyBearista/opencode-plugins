# opencode-adversarial-review

<p align="center">Challenge code with adversarial review</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-adversarial-review"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-adversarial-review?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-adversarial-review"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-adversarial-review?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6
  " /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>
---

## Why?

> Provides an adversarial code review agent that challenges implementation approach and design choices, not just finding bugs. Uses a clean-context subagent so the review is unbiased by conversation history.

## Philosophy: Extending OpenCode

OpenCode is designed to be highly extensible. This plugin hooks into the OpenCode lifecycle to provide additional functionality seamlessly into your workflows. <!-- AGENT: ONLY WHEN THE PLUGIN IS AT V1.0.0—as per user instruction, add an additional 1-2 sentences to this paragraph. OTHERWISE, LEAVE THIS INSTRUCTION IN >

### Architecture

<!-- AGENT: ONLY WHEN THE PLUGIN IS AT V1.0.0—as per user instruction, replace this comment with an ASCII tree or diagram explaining the high-level architecture or hook structure of the plugin. OTHERWISE, LEAVE THIS INSTRUCTION IN -->

## Features

<!-- AGENT: ONLY WHEN THE PLUGIN IS AT V1.0.0—as per user instruction, replace this comment with a bulleted list of the plugin's main features and capabilities. OTHERWISE, LEAVE THIS INSTRUCTION IN -->

## Install

<!-- AGENT: ONLY WHEN THE PLUGIN IS AT V1.0.0—as per user instruction, based on {{TYPE}}, keep ONLY the relevant block(s) below and remove the others. Note that plugins that with {{TYPE}} of tui or both should NOT instruct the user to use the CLI command. OTHERWISE, LEAVE THIS INSTRUCTION IN -->

<!-- AGENT: IF {{TYPE}}==server ONLY -->
Add the plugin to `opencode.json` or `opencode.jsonc`:
```json
{
  "plugin": ["@capybearista/opencode-adversarial-review"]
}
```

You can also install it through the CLI:

```bash
opencode plugin -g @capybearista/opencode-adversarial-review    # global install
opencode plugin @capybearista/opencode-adversarial-review       # project-local install
```

## Usage

<!-- AGENT: ONLY WHEN THE PLUGIN IS AT V1.0.0—as per user instruction, replace this comment with actual usage instructions or examples. OTHERWISE, LEAVE THIS INSTRUCTION IN -->

## Configuration

<!-- AGENT: ONLY WHEN THE PLUGIN IS AT V1.0.0—as per user instruction, replace this comment with a Markdown table detailing the properties in the config JSON, their types, and descriptions. If no configuration *of the plugin itself* is needed, write in this section, "This plugin requires no manual configuration.". OTHERWISE, LEAVE THIS INSTRUCTION IN -->

## Troubleshooting

<!-- AGENT: ONLY WHEN THE PLUGIN IS AT V1.0.0—as per user instruction, replace this comment with actual troubleshooting tips in the form of bullet points. OTHERWISE, LEAVE THIS INSTRUCTION IN -->

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on adversarial code review.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](LICENSE)
