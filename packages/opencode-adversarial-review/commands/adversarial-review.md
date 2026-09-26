---
description: "Run an adversarial code review that challenges the implementation. Args: [<sha|pr-url|pr-number>] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]"
agent: adversarial-reviewer
subagent: true
metadata: This command is managed by @capybearista/opencode-adversarial-review. Alter it as you please, but note it will get overridden if you update the plugin.
---

# Adversarial review handoff

You are the adversarial reviewer for this repository. Review the change and return the structured JSON verdict defined in your system prompt.

Args and focus: $ARGUMENTS

Target selection:
- A pull request URL always wins: when an argument is a PR URL, that URL selects the PR, no matter where it appears or what other target tokens are present.
- Otherwise, the first bare token decides: an all-decimal number is a PR number, and a hex string of 7 or more characters containing at least one letter a-f, or any full-length 40-character SHA, is a commit. A pure-decimal string is never a commit, so `1234567` is PR #1234567.
- A first bare token that matches neither class (including non-hex non-decimal tokens) is reported plainly as unresolvable and never scope-reviewed; hex matching is case-insensitive (A-F accepted), a 40-character all-decimal token is read as a commit SHA because the length rule wins over the decimal rule, and multiple PR URLs resolve first-URL-wins with the remainder reported, not reviewed.
- An explicit target (PR URL, PR number, or commit SHA) beats `--scope` and `--base`: when one is present, those flags are ignored.
- The first target token wins; any remaining trailing text is the focus area.
- Before resolving a bare PR number, verify the current repository with `git remote -v`; a bare number is resolved in the current repository only, and any `user:token@` credentials in the remote output are redacted before you reason about it.
- Resolve PR URLs against the current repository only: if a URL points at another repository, stop and warn explicitly unless the user asked for a cross-repo review.
- A commit target is reviewed with `git show <sha>` yourself, and files at that revision are read with `git show <sha>:<file>` instead of their working-tree copies.
- A pull request target is reviewed with `gh pr view <pr-or-url>` and `gh pr diff <pr-or-url>` yourself. If `gh` is missing or unauthenticated, report that plainly instead of guessing at the change; when `gh` fails, report its stderr verbatim.
- For a commit or pull request target, prefer the evidence you collect yourself over the working-tree snapshot blocks: they describe the current checkout, not the selected target.
- Otherwise, select the review scope with the flags below.

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
