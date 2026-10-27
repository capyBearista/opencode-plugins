# @capybearista/opencode-output-styles

## 2.2.0

### Minor Changes

- 321a10c: Switching styles no longer breaks the prompt cache. The style now travels as an OpenCode session instruction entry instead of being added to the system prompt, so a switch appends a short update rather than rewriting the conversation. Each message's reminder is recorded when it is sent and never changes, and messages sent with no style get no reminder.
  
  Breaking: requires OpenCode 2.2.0 or later. The `keep-coding-instructions` frontmatter field is no longer supported and is ignored; OpenCode's base prompt is always kept.

## 2.1.0

### Minor Changes

- ec9f426: Clearer picker wording: "None" means no style, "Use global" follows the global setting, the picker title says whether it edits this session or the global setting, and the sidebar reads "Output Style: <Name>". Breaking: `/output-style default` and `/output-style follow` are now `/output-style none` and `/output-style global`, and the `ctrl+d` picker shortcut is gone; change the global setting from the home screen instead.

## 2.0.0

### Major Changes

- 171e4be: Rewrite for OpenCode V2 (>= 2.0.23) as a server + TUI plugin installed from `opencode.jsonc` only. Ships Claude Code's four built-in styles (Proactive, Concise, Explanatory, Learning), a `/output-style` command, a picker, and a clickable "Style: <Name>" sidebar line, with per-session styles and a global default. Breaking: drops OpenCode V1 support (V1 users should pin `@capybearista/opencode-output-styles@1`), style state no longer lives in `.opencode/active-style.json`, and style files must sit directly in an `output-styles` directory (subfolders are not scanned).

## 1.0.2

### Patch Changes

- 608d2ff: Require `@opencode-ai/plugin` `>=1.19.3 <2`. The floor follows the SDK that is tested against; the new upper bound keeps this V1 plugin from claiming OpenCode 2.x support.

## 1.0.1

### Patch Changes

- 1ae9e1a: fix(output-styles): revert included output styles to original behavior

## 1.0.0

### Major Changes

- cabf145: Ship built-in output styles (explanatory, learning) that ship with the plugin and are automatically available. Users can override any built-in style by creating a .md file with the same id in their local or global output-styles directory, following the precedence: local > global > built-in.

  The style body is now wrapped in <output-style> tags when injected into the system prompt, replacing the previous # Output Style: header format.

  Modularized the plugin architecture, extracting style parsing, discovery, and built-in loading into a separate styles.ts module.
