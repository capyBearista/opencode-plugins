# Adversarial-Review Re-orientation — Execution Plan

Supersedes the remediation plan below in this same file. Remediation Phases 1–4
are implemented and verified on branch `feat/adversarial-review-v2-port`
(uncommitted). This plan re-orients delivery: the plugin owns the
`adversarial-reviewer` agent; a host-discovered Markdown command owns routing.

Locked decisions (user): auto-install the command file at setup into the global
commands dir (correct path `~/.config/opencode/commands/`, honoring
`OPENCODE_CONFIG_DIR`); agent stays in-memory via `agent.transform`, no file;
full context collection via shell blocks; remove the plugin `execute` command
entirely; inherit parent model unless specified (ship no `model:` line).

## SHIP-BLOCKER (decide before implementing)

Argument injection in the template design. The host substitutes `$ARGUMENTS`
*before* scanning for `!`-backtick blocks, so an argument containing a
backtick block becomes an executed sixth shell block, outside reviewer tool
permissions. Omitting `$ARGUMENTS` does not help (fallback appends raw args
before shell matching). Do not ship the template against this evaluator
without a host fix — which is out of scope — or a template design that keeps
user arguments out of shell evaluation entirely. This is the first decision
gate; everything below assumes it is resolved.

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

## Phase 4 — Live verification (after SHIP-BLOCKER resolved)

1. Restart host; `/adversarial-review` runs as a linked background child of the
   invoking session; parent model inherited with no model lines set.
2. Injection canary as an argument appears literally, never executes (currently
   expected to FAIL — the blocker).
3. Disposable git fixture: staged/unstaged diff, untracked texts, newline
   name, binary, escaping symlink, missing repo — compare against old
   `collectGitContext` semantics; reviewer must not bless missing evidence.
4. One success + one failed child + one malformed-completed run; observe
   parent-side delivery for each.
5. Root `typecheck && lint && test && build` green; no commits without explicit
   instruction.

## Follow-ups (not this plan)

- Plain `/review` command. Release (`2.0.0` on `latest` per ram-monitor path).
- Windows/macOS template port if platform scope widens.

---

## SUPERSEDED: Remediation plan (implemented, uncommitted)

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
