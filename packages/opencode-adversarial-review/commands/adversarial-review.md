---
description: "Run an adversarial code review that challenges the implementation. Args: [<sha|pr-url|pr-number>] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]"
agent: adversarial-reviewer
subagent: true
metadata: This command is managed by @capybearista/opencode-adversarial-review. Alter it as you please, but note it will get overridden if you update the plugin.
---

# Adversarial review handoff

You are the adversarial reviewer for this repository. Review the change and return the structured JSON verdict defined in your system prompt.

Target selection, focus weighting, evidence rules, and the output contract live in your system prompt — follow them.

Args and focus: $ARGUMENTS

The blocks below are a point-in-time snapshot rendered by this template. They can be incomplete: commands can fail, output can be empty, and untracked file contents are not inlined. Verify everything with your own read-only tools before reporting.

- Branch:
  !`git branch --show-current 2>&1 || true`
- Status:
  !`git status --short --untracked-files=all 2>&1 || true`
- Recent commits:
  !`git log --oneline -3 2>&1 || true`
- Working-tree diff against HEAD:
  !`git diff HEAD 2>&1 || true`
- Untracked files (paths only; read their contents with your tools):
  !`git ls-files --others --exclude-standard 2>&1 || true`
