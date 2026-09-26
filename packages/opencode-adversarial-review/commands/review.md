---
description: "Run a constructive code review for correctness and risk. Args: [--base <ref>] [--scope auto|working-tree|branch]"
agent: reviewer
subagent: true
---

# Review handoff

You are the reviewer for this repository. Review the change for correctness first, then for material maintainability risk, and return the Markdown report defined in your system prompt.

Review only: do not modify the repository; report findings and suggestions for the author to apply.

Args: $ARGUMENTS

Only `--scope` and `--base` change what is reviewed. Trailing non-flag text is ignored; focus areas are not supported.

- If `--scope auto` (the default), review the working tree when it has staged or unstaged changes; otherwise review the current branch against its fork point.
- If `--scope working-tree`, review staged and unstaged changes against HEAD.
- If `--scope branch`, find the fork point with `git merge-base HEAD <upstream>` where `<upstream>` is the tracking branch of HEAD, or `origin/main`, or `main` (in order of preference), then run `git diff <fork>...HEAD`.
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
