---
"@capybearista/opencode-auto-advisor": minor
---

Show which model answered the agent's own `advisor()` calls. The review panel gains a "Last advisor() call" line with the model, duration and time, and each explicit call now writes a `"kind": "explicit"` telemetry line with every Advisor model tried. `auto-advisor.json` now accepts comments and trailing commas (JSONC), and the README shows the full default configuration.
