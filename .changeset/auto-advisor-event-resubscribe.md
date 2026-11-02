---
"@capybearista/opencode-auto-advisor": patch
---

Keep listening for the end of a run after the event stream fails. Before, one failed read stopped the listener until OpenCode restarted: Esc no longer ended a pending automatic review, a review of an interrupted run was delivered late into the next prompt, and finished requests stayed in memory. The plugin now subscribes again after one second.
