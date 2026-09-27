# AGENTS.md

## Overview

**Technology**: TypeScript / OpenCode Plugin
**Entry Point**: `src/index.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: V2 (`@opencode/plugin` 2.0.2, `Plugin.define`) — server entry only, no TUI. The release policy now lists the V2 `latest` line (`releaseClass: v2`); the `2.0.0` release is still unreleased pending the Version Packages flow, so `@latest` resolves to the V1 `1.0.0` line until it publishes. Keep V1 (singular `plugin` key) and V2 (plural `plugins` key) hosts apart.

This plugin provides **two code-review agents** for OpenCode: an adversarial reviewer (`/adversarial-review`, "break confidence, not validate") and a constructive reviewer (`/constructive-review`, correctness-first with suggestions). It ports the Codex CLI's review concepts to OpenCode's agent system.

## Architecture

### Two Reviewers, One Mechanics

`src/index.ts` defines a two-entry `REVIEWERS` config (`agentId`, `commandFilename`, `description`, `systemPrompt`) and loops the same machinery for both: install both command files and register both agents.

1. **Agents (in memory)** — `setup()` registers the hidden `adversarial-reviewer` and `constructive-reviewer` subagents through `ctx.agent.transform`. No agent file is ever written. The plugin enforces the do-not-invoke descriptions, `subagent` mode, hidden flag, and the shared read-only permission set; a host-defined `system` or `color` survives the update.

2. **Commands (on disk)** — `commands/adversarial-review.md` and `commands/constructive-review.md` are the packaged templates. `setup()` installs each with an atomic `wx` first write at:

   ```
   <OPENCODE_CONFIG_DIR ?? ~/.config/opencode>/commands/{adversarial-review.md,constructive-review.md}
   ```

   The host discovers them as `/adversarial-review` and `/constructive-review` and, because each frontmatter sets its agent and `subagent: true`, routes each to a linked background child of the invoking session. The host expands a template: `$ARGUMENTS` substitution first, then the five `!`-backtick shell blocks (branch, status, recent commits, `git diff HEAD`, untracked file list). The template itself carries no review rules: frontmatter (including the `managed_version` stamp and ownership metadata), the handoff, one pointer line, `$ARGUMENTS`, the snapshot caveat, and the five shell blocks only. On a later `/reload` or restart, an existing file in the plugin's ownership (a known, not-newer stamp) is refreshed from the packaged template.

3. **Prompts (packaged)** — `src/prompt.ts` holds both canonical system prompts; `src/prompts/adversarial-review.md` and `src/prompts/constructive-review.md` are the lockstep reference copies. They are the sole home of review doctrine: target selection, focus handling, evidence rules, and the output contract live there, never in the command templates. `src/index.ts` stays limited to agent registration and command installs: the reviewers collect evidence with their own read-only tools, and the plugin never post-processes their answers.

### Flow

```
User: /adversarial-review --base main check auth  (or /constructive-review --scope branch)
  ↓
Host expands the installed template (arguments, then shell blocks)
  ↓
Child session (agent: adversarial-reviewer or constructive-reviewer, parent-linked background subagent)
  ↓
Reviewer: scope selection → self-collected evidence (read/grep/glob/git, plus `gh pr` for PR targets) → requested output format
  ↓
Parent session receives the child result as-is
```

Model resolution is the host chain: command frontmatter `model` → configured agent model (`adversarial-reviewer` / `constructive-reviewer`) → invoking session model. The shipped templates have no `model:` line, so the parent model is inherited by default. The adversarial prompt requests JSON and the review prompt requests a Markdown report; neither the plugin nor the host validates either format. A failed child surfaces as `state="error"`; malformed-but-completed text surfaces as completed.

### Key Design Decisions

- **No custom tool**: Context priming comes from the installed command templates' shell blocks; each reviewer self-collects the rest with whitelisted read-only tools, including `git show` for commit targets and `gh pr view` / `gh pr diff` for PR targets.
- **No primary agent involvement**: `subagent: true` routes directly to the reviewer. Zero conversation history leak.
- **Least privilege**: Both reviewers share one permission set. `edit`/`write`/`patch`, `subagent`, `skill`, `question`, `webfetch`, `websearch`, `external_directory`, and general `shell` are denied; `read`/`glob`/`grep` and 13 `git` command prefixes are allowed (`git branch` is limited to `--show-current`, `git remote` to the read-only `-v` listing; `--ext-diff`/`--textconv`/`--output` are denied after the allows). The read-only GitHub surfaces are also allowed (`gh pr view*`, `gh pr diff*`, plus the `gh auth status*` diagnostic) with an explicit catch-all `gh *` deny ordered before those allows, since evaluation is last-match-wins; `gh auth login`/`logout`/`token` stay denied, and the token-printing forms `gh auth status --show-token` / `-t` are denied by rules ordered after the diagnostic allow. `.env`/`.env.*` is denied after the general allow for read, grep, and glob; `git diff*` with `--no-index` and `git show*` colon-path `.env`/`.env.*` access are denied after the git allows, with a `git show*:*.env.example` allow after those denies so the example file stays readable at a revision like it is through read/grep/glob (other secret extensions such as `.pem` remain readable — a known limitation). Because that allow is full-string anchored and also matches any command merely ending in `.env.example`, the `git show` engine-flag denies are re-asserted after it (the merge preserves intentional intra-list duplicates) and secret-then-more-args denies (`git show*:*.env *`, `git show*:*.env.* * *`) follow so a secret colon-path followed by further arguments stays denied. Inherited `ask` rules are dropped because the reviewers run unattended, and pre-existing host denies are re-appended after the plugin rules so they outrank plugin allows.
- **Version-stamped install**: the first write is atomic (`wx`). On EEXIST the install runs `lstat` first, so a symlinked leaf is never followed, read, or truncated and keeps the preserve-and-warn path. A regular file whose `managed_version` stamp is known to this build and no newer than the shipped template is overwritten in place with the bundled template and an info-level log. A file with the stamp removed, an unknown or newer stamp, or other custom content is preserved with the stale-or-customized warning naming both update paths (edit in place or delete) and the delete-to-uninstall step. The stamp is the ownership switch: keeping it means updates on `/reload` or restart, removing it takes ownership. The refresh write uses `O_NOFOLLOW` to close the lstat-to-write race, and opens explicitly so a failed open (nothing truncated) preserves the intact file while only a failed handle write after `O_TRUNC` unlinks the stranded partial file. Permission/missing-parent failures abort setup before either agent is registered. After both installs, setup also cleans up a pre-rename `commands/review.md` leftover (see Edge Cases).
- **Temperature inheritance**: the plugin registers no session hooks and pins no temperature; each reviewer inherits the invoking session's temperature along the parent chain, exactly like model resolution. There are no host-wide hook events to warn about.
- **Target kinds (prompt-only doctrine)**: both prompts resolve the target deterministically: a PR URL always wins; otherwise the first bare token decides (all-decimal → PR number, a 7+ character hex string containing a letter a-f case-insensitively or any full-length 40-character SHA → commit, pure-decimal strings are never commits, and a 40-character all-decimal token is read as a commit because length wins over the decimal rule), and an explicit target beats `--scope`/`--base`, which are then ignored. A token matching neither class (including non-hex non-decimal tokens) is reported plainly as unresolvable and never scope-reviewed; with multiple PR URLs, the first wins and the remainder is reported. Evidence is gated by target: a commit target is limited to `git show <sha>` / `git show <sha>:<file>` (no working-tree reads of versioned files), while a PR target gathers `gh` evidence first and reads a working-tree file only when it is verified at the PR head revision by comparing `gh pr view --json headRefOid` with `git rev-parse HEAD` and `git status --short -- <file>` reports no change to it; a dirty file is read from the PR revision (`git show <headOid>:<file>`) or via `gh` evidence instead. The `--scope auto` fallback to branch scope still reads untracked files from the working tree because they never appear in the branch diff. If `gh` is missing, unauthenticated, or fails, the reviewer reports that plainly (stderr verbatim on failure) instead of guessing; a cross-repo PR URL stops with an explicit warning unless the user asked for cross-repo review. `user:token@` credentials in `git remote -v` output are redacted before reasoning. None of these rules are restated in the command templates.
- **Ownership marker, no checksums**: the `managed_version` stamp is the only ownership detection; the plugin never hashes or diffs installed bytes. A stamped file is refreshed wholesale, so manual edits inside a stamped file are overwritten; removing the stamp makes the file user-owned and permanently preserved.

### Maintenance Rules

- Keep each prompt pair byte-for-byte in lockstep: `src/prompt.ts` ↔ `src/prompts/adversarial-review.md` and `src/prompts/constructive-review.md` (the tests assert both).
- Keep the command templates free of doctrine: they carry the handoff, one pointer line, `$ARGUMENTS`, the snapshot caveat, and the five shell blocks only; put target-selection, focus-handling, evidence, and output rules in `src/prompt.ts` and its lockstep references. One guardrail exception: `constructive-review.md` keeps the single read-only sentence (`Review only: do not modify the repository; report findings and suggestions for the author to apply.`) — safety, not doctrine — and it is the only entry in the tests' doctrine-tripwire allowlist; `adversarial-review.md` must not carry it.
- Keep `commands/adversarial-review.md` and `commands/constructive-review.md` shipped through the package.json `files` array (`"commands"`); they are loaded relative to the built entry as `../commands/`.
- Keep each frontmatter minimal: `description`, `agent: <matching agent id>`, `subagent: true`, `managed_version: <current>`, and the ownership `metadata` line. No `model:` line. Unknown frontmatter keys are ignored by the host schema, so additive `metadata` is safe. Both templates version together: when a shipped template changes, bump `managed_version` and add the previous version to `KNOWN_TEMPLATE_VERSIONS` and `CURRENT_TEMPLATE_VERSION` in `src/index.ts`.
- When changing tool permissions, re-check the least-privilege model and both installed templates' shell blocks together.
- Live-test loop: the host loads plugin code once at startup — after rebuilding, run `/reload` in the host (no restart needed) and re-sync the installed `~/.config/opencode/commands/*.md` copies before invoking the commands.
- Platform posture: tested on GNU/Linux with a Bash-compatible shell; do not present other platforms as tested. The agent side (read/glob/grep/git through the host tool abstraction) is portable, and only the five snapshot blocks are shell-dependent. On POSIX sh each block ends `|| true` and renders partially with zero exit; on non-POSIX shells blocks may fail entirely — if the reviewer is reached, the snapshot caveat tells it to self-collect, so treat the snapshot as incomplete.

### Edge Cases

- **Existing command file**: a regular file whose stamp is known and not newer is refreshed in place from the bundled template (info log); a file with the stamp removed, an unknown or newer stamp, or a symlinked leaf is left untouched with a warning naming that file. A refresh whose `O_TRUNC` open fails (for example a readable-but-unwritable file) preserves the intact file and still aborts setup; only a failed write on the already-open handle unlinks the stranded partial file. Delete + `/reload` or restart still force-reinstalls the bundled template. Uninstalling the plugin does not delete either file; manual removal is the uninstall step.
- **Stale pre-rename `review.md`**: a pre-rename build installed the second reviewer as `commands/review.md` with `agent: reviewer`, an id this build no longer registers, so the host discovers it as a broken `/review`. After both current commands install, setup inspects that exact filename only: `agent: reviewer` plus a `managed_version` stamp in `KNOWN_TEMPLATE_VERSIONS` is provably ours and is removed with an info log; `agent: reviewer` with a missing or unknown stamp is preserved with a loud warning naming the file, the broken-command risk, and the manual delete step; any other content is left untouched and silent.
- **Missing/unwritable `commands/` directory**: setup throws with the failing path and registers neither agent, even when the other file installs first.
- **No changes**: the shell blocks render empty output; the reviewer reports there is nothing to review.
- **Large diff**: the template's diff block may be large; the reviewer reads surrounding code and untracked contents with its tools rather than assuming the snapshot is complete.
- **No git repo**: each shell block appends `2>&1 || true`, so failures render as text instead of aborting the command.
- **Focus text on `/constructive-review`**: not supported. Focus areas are unsupported (Codex parity); only `--scope`, `--base`, a bare commit SHA, and a PR URL/number select the target. Other trailing non-flag text is accepted by the host and ignored by the prompt.
- **PR target without `gh`**: `gh pr view` / `gh pr diff` fail when `gh` is missing or unauthenticated. The prompt instructs the reviewer to report that plainly (stderr verbatim on failure) instead of guessing, and to stop with an explicit warning when the URL points at another repository unless the user asked for a cross-repo review; SHA and scope targets are unaffected.
- **Remote-credential redaction is prompt-only (finding 4)**: no command-template block prints remotes — the reviewer runs `git remote -v` itself — so redacting `user:token@` credentials before reasoning relies on the prompt rule and model compliance, with no host-side output filtering available. Template-side filtering is impossible because no template block prints remotes.
- **Injection warning (accepted paste-risk)**: `$ARGUMENTS` is substituted before the shell blocks are evaluated, so argument text can become executable shell content for either command. Commit SHAs and PR URLs travel the same substitution path as plain text and add no new risk class. Both commands are human-invoked; the risk is accepted and documented, with no host-side fix planned. Safe invocation: inspect arguments before invoking, and never pass untrusted or pasted Markdown containing backtick blocks as arguments.

## Quick Reference

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `bun run build`     | Compile TypeScript         |
| `bun run typecheck` | Type check                 |
| `bun run lint`      | Lint (Biome)               |
| `bun run check`     | Lint and format (Biome)    |
| `bun run ci`        | CI mode (non-mutating)     |
| `bun test`          | Run tests                  |
| `bun run smoke`     | Build + built-entry smoke  |

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use the host `app.log` sink when available (see `createHostLogger`).
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- For rule changes (permissions, resolvers, parsers), require a red→green test demonstrating the old behavior fails first — this caught real regressions twice (over-broad `git branch*`, strict-parser fallback).
- Install tests run setup in a subprocess with an isolated temp `HOME`; never write to the real config directory in tests or smoke.
- Runtime smoke: `bun run smoke` verifies the built entry registers both reviewer agents, installs both command files, enforces the permission/description contract for each, and registers no session hooks (only agent disposers).

## License

MPL-2.0