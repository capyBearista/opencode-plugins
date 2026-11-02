---
"@capybearista/opencode-auto-advisor": minor
---

The Advisor chain key is now `advisor.models`, matching `routing.models`. Both take one `"provider/model[#variant]"` string or an ordered list; `routing.models` now accepts a single string too.

Breaking: rename `advisor.model` to `advisor.models` in `auto-advisor.json`. A file that still uses `advisor.model` is rejected as `unknown key: advisor.model`, which turns automatic reviews off and makes `advisor()` return the error.
