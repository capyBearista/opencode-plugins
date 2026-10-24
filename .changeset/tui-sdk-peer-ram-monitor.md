---
"@capybearista/opencode-ram-monitor": patch
---

Mark the `@opencode/plugin` peer optional. OpenCode serves `@opencode/plugin/tui` from its own runtime, so installs no longer download an unused copy of the SDK.
