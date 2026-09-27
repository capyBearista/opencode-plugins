# Adversarial-Review Re-orientation — Execution Plan

Supersedes the remediation plan below in this same file. Remediation Phases 1–4
were implemented and verified on branch `feat/adversarial-review-v2-port`
(committed as `e446bdf`). This plan re-orients delivery: the plugin owns the
`adversarial-reviewer` agent; a host-discovered Markdown command owns routing.

Status: Phases 1–3 implemented, reviewed (two rounds), and committed. The
argument-injection gate below is resolved as an accepted paste-risk (user
decision); README and package AGENTS.md carry the warning. Phase 4 is partly
verified (reinstall + failure delivery confirmed live); branch-scope runs are
pending a user test pass.

Locked decisions (user): auto-install the command file at setup into the global
commands dir (correct path `~/.config/opencode/commands/`, honoring
`OPENCODE_CONFIG_DIR`); agent stays in-memory via `agent.transform`, no file;
full context collection via shell blocks; remove the plugin `execute` command
entirely; inherit parent model unless specified (ship no `model:` line).

## SHIP-BLOCKER — resolved as accepted paste-risk (user decision)

Argument injection in the template design. The host substitutes `$ARGUMENTS`
*before* scanning for `!`-backtick blocks, so an argument containing a
`!`-plus-backtick block becomes an executed sixth shell block, outside
reviewer tool permissions. Omitting `$ARGUMENTS` does not help (fallback
appends raw args before shell matching). A host fix is out of scope and none
is planned.

Decision: accept as a human-invoked-surface paste-risk and ship with a
warning (README + package AGENTS.md: "Injection warning (accepted
paste-risk)"). Safe-invocation rule: never pass untrusted or pasted Markdown
containing backtick blocks as command args; inspect args before invoking.
Note: a canary without the `!` prefix (e.g. backtick-only `echo INJECTED`)
correctly does nothing — only `!`-backtick forms execute. The full
`!`-canary was skipped by user decision; the accepted risk stands as
documented.

## Phase 1 — Command asset + auto-install

1. Add `commands/adversarial-review.md` to the package (frontmatter:
   `description`, `agent: adversarial-reviewer`, `subagent: true`, NO `model:`
   line; body per the template lane: handoff + `$ARGUMENTS` + five shell
   blocks for branch/status/commits/full-diff/untracked). Ship it in
   `package.json` `files`. GNU/Linux + Bash only — declare the platform scope;
   no cross-platform parity claims without a tested port.
2. At setup, write-once-if-absent to
   `<OPENCODE_CONFIG_DIR ?? ~/.config/opencode>/commands/adversarial-review.md`
   via atomic `wx` flag. `EEXIST` → leave untouched with a stale-or-customized
   diagnostic. `EACCES`/`EROFS`/missing-parent → fail setup loudly (never a
   registered agent with no command). Check `agent.transform` availability
   first. No checksums, no markers, no symlink following.
3. Dispose releases in-memory registrations only; the file stays. Document
   manual removal as the uninstall step.
4. Tests (isolated temp HOME, subprocess isolation — never mutate real HOME):
   file created with valid frontmatter/body; second setup preserves hand-edited
   bytes; symlink untouched; `OPENCODE_CONFIG_DIR` override targets only the
   override; failure surfaces a path-bearing error; no agent file is ever
   written; no `command.transform` is called.

Acceptance: host discovers the installed file as `/adversarial-review` routed
to the reviewer; project-local override precedence intact; gates green.

## Phase 2 — Plugin surgery (`src/index.ts`, dead code, tests, smoke)

1. Delete the execute engine: `collectGitContext`/`buildReviewMessage`/schema
   imports, `COMMAND_NAME`, session-title/synthetic/description constants for
   the command path, `ReviewModel`/`ReviewFailureCode` types, model resolution,
   validator + extraction + categorization helpers, the full
   `ctx.command.transform` block, and `activeReviewSessions`.
2. Keep: `Plugin.define`, `agent.transform`, `configureReviewerAgent` (hidden
   subagent, do-not-invoke description — REVISED to name the installed template
   path, not plugin-collected context), hex color, permissions incl. self-deny
   and zero-ask construction, `createErrorLogger`, both temperature hooks
   re-keyed from the session-id set to `event.agent === REVIEWER_AGENT_ID`.
3. Delete `src/git-context.ts`, `buildReviewMessage`, `src/schemas/*` +
   `scripts/check-schema-asset.ts` + its build hook + `resolveJsonModule` (if
   unused). Keep `src/prompt.ts` system prompt + reference md in lockstep, but
   rewrite both copies: reviewer collects evidence with its tools; no claims of
   inlined full diff/bodies. Schema contract lives in prompt text only.
4. Tests (64 → ~20): keep 11 (definition/package/host-resolution/agent
   props/permissions/logging/missing-hook), adapt 9 (no command transform;
   file/frontmatter assertions; agent-scoped temperature; three disposers),
   delete 44 (execute/model/context/delivery/validation). Delete dead harness
   (invocation/command/session mocks, runReview, git fixtures). Add:
   install-discovery, frontmatter/body, reviewer registration, hook isolation.
5. Rewrite `scripts/smoke-built.ts`: built-entry agent registration,
   permission/description checks, hook calls for reviewer vs unrelated agent.
   Drop invocation/synthetic/validation assertions.

Acceptance: suite + typecheck/lint/build + smoke green; no `command.transform`
reference anywhere; temperature fires for reviewer agent only.

## Phase 3 — Docs + disclosure rewrite

1. README: plugin registers the agent; command arrives via auto-installed file
   (path, write-once semantics, manual-update + manual-uninstall notes);
   model = host chain (command → agent → parent), pin via installed copy's
   frontmatter; structured JSON is *requested*, not enforced; child failure
   reaches the parent as `state="error"`, malformed-but-completed text arrives
   as completed; shell blocks run outside permission flow (trust warning);
   disclosure = template-inlined working tree, no secret scanning.
2. Package `AGENTS.md`: replace V1 flow + stale model/edge claims with the new
   split (agent in plugin, command on disk).
3. Update the reviewer system prompt + reference md together (evidence
   collection wording); keep the verbatim-JSON rule as guidance.

Acceptance: no remaining claims of plugin-collected context, validation,
synthetic delivery, `options.model`, or command templates; docs describe the
installed file as the single path.

## Phase 4 — Live verification (status after e446bdf)

1. Restart host; `/adversarial-review` runs as a linked background child of the
   invoking session; parent model inherited with no model lines set.
   VERIFIED live (user session + reviewer run: valid JSON delivered).
2. Injection canary: risk accepted (see SHIP-BLOCKER above). Backtick-only
   canary correctly no-ops; full `!`-canary skipped by user decision.
3. Disposable git fixture (staged/unstaged diff, untracked texts, newline
   name, binary, escaping symlink, missing repo): SKIPPED by user decision.
4. Success run observed live (valid JSON, completed delivery). Failed child
   observed live — killing the child surfaces an error to the parent
   (user-confirmed). Malformed-completed run not yet observed live.
5. Package gates green (`bun test` 28 pass, typecheck, `biome ci`, smoke).
   Command reinstall confirmed live by user (delete + restart reinstalls).
   Branch-scope runs (`--scope branch`, `--base <ref>`) pending a user test
   pass. Root `typecheck && lint && test && build` not yet run on this work.

## Follow-ups

- NEXT: plain `/review` command/agent (queued; not yet planned in detail).
- Release (`2.0.0` on `latest` per ram-monitor path): open — needs a `v2`
  policy entry + major changeset → Version Packages PR → publish + registry
  check, plus `docs/v1-plugins.md`, root AGENTS.md/README, and package
  AGENTS.md authority updates.
- Windows/macOS template port: DROPPED (user decision). The template stays
  GNU/Linux + Bash only: the five `!`-backtick blocks assume a
  Bash-compatible shell and GNU/git CLI behavior, execute through the invoking
  user's shell outside any permission sandbox, and have no tested equivalent
  for PowerShell/cmd or macOS BSD-tool differences. Claiming parity without a
  tested port would be dishonest, and the hosts in scope are Linux, so the
  port cost buys nothing right now. Revisit only if a non-Linux host needs
  support.

---

## SUPERSEDED: Remediation plan (implemented, committed as e446bdf)

Branch: `feat/adversarial-review-v2-port`. Session deletion out of scope.
Plain `/review` is a follow-up.

Locked decisions (user, prior round): root sessions stay; lockdown denies
dropped for a do-not-invoke description; model inherits caller, override wins,
unreadable caller fails; no caps; malformed output throws with no synthetic and
no retry; zero ask-effects. All four phases below are implemented (64 tests
green, review approve-with-changes, 5 minors fixed, root gates green).

### Phase 1 — Session policy reversal: DONE
Unconditional command-path description; `lockReviewerSpawn` deleted; other
agents untouched (tested); README caveat added.

### Phase 2 — Model inheritance: DONE
`options.model === undefined` only inherits; `session.get` verbatim with
variant; pre-create throws with actionable message; invalid overrides throw.

### Phase 3 — Cap-free context: DONE
All caps/stat-fallback/truncation deleted; streaming spawn, NUL enumeration,
full-file reads, boundary+symlink checks, binary NUL-skip; both prompt copies
rewritten; README disclosure; stale claims removed.

### Phase 4 — Failure validation + ask elimination: DONE
Latest-assistant-only validation, categorized throws, zero synthetics on
failure, zero ask-effects, schema-asset build check.
