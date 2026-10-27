---
"@capybearista/opencode-adversarial-review": patch
---

Create the `commands/` directory on setup when it is missing. Before, a config directory without `commands/` made setup fail and neither reviewer agent was registered.
