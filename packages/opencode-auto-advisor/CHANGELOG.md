# @capybearista/opencode-auto-advisor

## 2.1.1

### Patch Changes

- 4eb95f9: Narrow the advisor() guidance to user requests, unresolved consequential decisions after focused investigation, and genuine stalls; reuse automatic reviews instead of re-requesting.

## 2.1.0

### Minor Changes

- b51db9e: Call the Decision model far less often. The new `routing.minStepsBetweenDecisions` (default 10; `1` restores every step) spaces Decision calls across a session, and a step where the cooldown or the per-turn limit already blocks a consult no longer calls it at all; its telemetry line now has no answers. This saves a free decision model's rate limit and keeps the paid fallback from taking over.
  
  Behavior change: with the default, a moment that falls on a skipped step gets no automatic review, and a turn shorter than 10 steps often ends without one. Lower the setting to trade calls for coverage.
- e9b379b: Show which model answered the agent's own `advisor()` calls. The review panel gains a "Last advisor() call" line with the model, duration and time, and each explicit call now writes a `"kind": "explicit"` telemetry line with every Advisor model tried. `auto-advisor.json` now accepts comments and trailing commas (JSONC), and the README shows the full default configuration.
- e231e2c: The Advisor chain key is now `advisor.models`, matching `routing.models`. Both take one `"provider/model[#variant]"` string or an ordered list; `routing.models` now accepts a single string too.
  
  Breaking: rename `advisor.model` to `advisor.models` in `auto-advisor.json`. A file that still uses `advisor.model` is rejected as `unknown key: advisor.model`, which turns automatic reviews off and makes `advisor()` return the error.

### Patch Changes

- a3f6b64: Keep listening for the end of a run after the event stream fails. Before, one failed read stopped the listener until OpenCode restarted: Esc no longer ended a pending automatic review, a review of an interrupted run was delivered late into the next prompt, and finished requests stayed in memory. The plugin now subscribes again after one second.
