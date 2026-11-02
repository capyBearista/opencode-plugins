---
"@capybearista/opencode-auto-advisor": minor
---

Call the Decision model far less often. The new `routing.minStepsBetweenDecisions` (default 10; `1` restores every step) spaces Decision calls across a session, and a step where the cooldown or the per-turn limit already blocks a consult no longer calls it at all; its telemetry line now has no answers. This saves a free decision model's rate limit and keeps the paid fallback from taking over.

Behavior change: with the default, a moment that falls on a skipped step gets no automatic review, and a turn shorter than 10 steps often ends without one. Lower the setting to trade calls for coverage.
