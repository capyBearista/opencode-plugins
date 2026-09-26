---
description: "Run an adversarial code review that challenges the implementation. Args: [--base <ref>] [--scope auto|working-tree|branch] [focus ...]"
agent: adversarial-reviewer
subagent: true
---

# Adversarial review handoff

You are the adversarial reviewer for this repository. Review the change and return the structured JSON verdict defined in your system prompt.

Args and focus: $ARGUMENTS

- If `--scope auto` (the default), review the working tree when it has staged or unstaged changes; otherwise review the current branch against its fork point.
- If `--scope working-tree`, review staged and unstaged changes against HEAD.
- If `--scope branch`, find the fork point yourself with `git merge-base HEAD <upstream>` and run `git diff <fork>...HEAD`.
- If `--base <ref>` is provided, use it as the base for the branch diff.

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

Platform scope: GNU/Linux with a Bash-compatible shell only. No Windows or macOS parity is claimed.
