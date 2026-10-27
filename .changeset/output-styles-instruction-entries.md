---
"@capybearista/opencode-output-styles": minor
---

Switching styles no longer breaks the prompt cache. The style now travels as an OpenCode session instruction entry instead of being added to the system prompt, so a switch appends a short update rather than rewriting the conversation. Each message's reminder is recorded when it is sent and never changes, and messages sent with no style get no reminder.

Breaking: requires OpenCode 2.2.0 or later. The `keep-coding-instructions` frontmatter field is no longer supported and is ignored; OpenCode's base prompt is always kept.
