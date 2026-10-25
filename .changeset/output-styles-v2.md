---
"@capybearista/opencode-output-styles": major
---

Rewrite for OpenCode V2 (>= 2.0.23) as a server + TUI plugin installed from `opencode.jsonc` only. Ships Claude Code's four built-in styles (Proactive, Concise, Explanatory, Learning), a `/output-style` command, a picker, and a clickable "Style: <Name>" sidebar line, with per-session styles and a global default. Breaking: drops OpenCode V1 support (V1 users should pin `@capybearista/opencode-output-styles@1`), style state no longer lives in `.opencode/active-style.json`, and style files must sit directly in an `output-styles` directory (subfolders are not scanned).
