---
"@capybearista/opencode-double-tap-timeline": patch
---

Declare `@opencode/plugin` as an optional peer (`>=2.0.0 <3`) instead of a pinned `2.0.0` dependency. OpenCode serves `@opencode/plugin/tui` from its own runtime, so installs no longer download an unused copy of the SDK.
