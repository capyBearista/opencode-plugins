# @capybearista/opencode-agent-prompt-inheritance

## 1.0.1

### Patch Changes

- 608d2ff: Require `@opencode-ai/plugin` `>=1.19.3 <2`. The floor follows the SDK that is tested against; the new upper bound keeps this V1 plugin from claiming OpenCode 2.x support.

## 1.0.0

### Major Changes

- 56c22e5: Add a new plugin that restores provider base system prompt inheritance for custom agents, mirrors upstream OpenCode prompt assets as vendored `.txt` files, and adds an automated daily upstream prompt-sync PR workflow.
