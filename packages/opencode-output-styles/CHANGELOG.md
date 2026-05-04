# @capybearista/opencode-output-styles

## 1.0.1

### Patch Changes

- 1ae9e1a: fix(output-styles): revert included output styles to original behavior

## 1.0.0

### Major Changes

- cabf145: Ship built-in output styles (explanatory, learning) that ship with the plugin and are automatically available. Users can override any built-in style by creating a .md file with the same id in their local or global output-styles directory, following the precedence: local > global > built-in.

  The style body is now wrapped in <output-style> tags when injected into the system prompt, replacing the previous # Output Style: header format.

  Modularized the plugin architecture, extracting style parsing, discovery, and built-in loading into a separate styles.ts module.
