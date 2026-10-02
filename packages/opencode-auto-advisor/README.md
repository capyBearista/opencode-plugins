# @capybearista/opencode-auto-advisor

An OpenCode V2 plugin that gives the Executor an independent reviewer. It adds
the zero-argument `advisor()` tool and an optional, experimental automatic review
router. The package is version `2.0.0` but has **not been published**; use it from
this repository's checkout for now.

## What it does

### Explicit review

The Executor can call `advisor()` with no arguments. The Advisor receives the
current session context, including tool activity and the work in progress, and
returns a concise review. Each call uses a fresh, stateless generation; no ongoing
Advisor conversation is kept. The Advisor has no tools to inspect files, run shell
commands, or delegate work; its instructions also tell it not to ask questions or
start another consultation. It is prompted to give qualitative advice, not scores
or confidence claims.

The selected Advisor model defaults to the in-flight Executor model. Set
`advisor.model` to use another model. Explicit calls do not use Jev routing or
the automatic per-turn consultation quota. An explicit call marks its captured
state reviewed, so automatic routing does not immediately consult again on the
same state; it does not spend the automatic quota. Model and provider errors,
including timeouts, are returned in the tool result; the plugin does not switch
to a fallback Advisor model.

### Automatic review

Automatic routing runs at the awaited primary `session.context` dispatch
boundary. It is off by default and can be enabled globally with `routing.mode`:

| Mode | Behavior |
| --- | --- |
| `off` | No automatic routing. The explicit `advisor()` tool remains available. |
| `observe` | Sends a bounded routing projection to Zen/System One, evaluates the policy, and records metadata. It does not call the Advisor or inject an automatic review. Shared tool-use guidance may still be added when the tool is available. **This mode is not local-only.** |
| `active` | Uses the same router and calls the Advisor when both policy thresholds pass and the per-turn quota is available. The pending Executor request waits for the review; accepted advice is added to its privileged system context. |

The router evaluates whether independent review could change the Executor's
immediate next action and scores the consequence from 0 to 4. An automatic
consultation is accepted only when both `advisorWouldHelp` and `consequence`
meet their configured thresholds. The default thresholds are `0.7` and `3`.

An unchanged request fingerprint is not reviewed again. New user input or
material tool/execution results can open another opportunity; Advisor-originated
activity alone does not. The default quota is one accepted automatic consultation
per user turn. In `active`, acceptance consumes it before the Advisor call, even
if that call fails. When the quota is exhausted, the Jev classifier is skipped;
`observe` consumes the same quota hypothetically on policy acceptance and keeps
evaluating for calibration. Explicit `advisor()` calls never consume it.

Automatic routing and delivery fail open: a router, Advisor, timeout, or
injection failure does not block the primary Executor dispatch. An Advisor
failure does not switch to another Advisor model. Successful
new and retained advice are delivered through privileged system context, not as
a chronological message update, synthetic user message, or fabricated tool
call. This may change the provider's leading system-prompt prefix and affect
prefix caching. The Executor gets reviewer guidance only when the `advisor` tool
is available. That guidance ranks user constraints first, then direct evidence
and tool results, then the Advisor's review, then speculation; conflicts should
be reconciled rather than followed blindly.

The native permission action is `advisor`. A native denial removes the explicit
tool and blocks automatic review, regardless of agent name. Root sessions may be
eligible; parented child sessions are never eligible.

In OpenCode V2, set `default_agent` at the top level and put the rule under that
agent's `permissions` array. For example, this denies Auto-Advisor for the
`build` root agent:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "build",
  "agents": {
    "build": {
      "permissions": [
        { "action": "advisor", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

V2 permission rules are ordered; later matching rules take precedence. Keep the
deny after any rule that would allow `advisor`, including any applicable
session-level rule. This is the V2 `agents` object and permissions array, not the
V1 `agent` map format.

## Configuration

Configuration is global and sparse. The file is
`$OPENCODE_CONFIG_DIR/auto-advisor.json` when `OPENCODE_CONFIG_DIR` is set;
otherwise it is `$XDG_CONFIG_HOME/opencode/auto-advisor.json`, or
`~/.config/opencode/auto-advisor.json` when `XDG_CONFIG_HOME` is unset.

```json
{
  "advisor": {
    "model": "inherit",
    "timeoutMs": 300000
  },
  "routing": {
    "mode": "off",
    "models": ["jev-1.13-free", "jev-1.13"],
    "advisorWouldHelpThreshold": 0.7,
    "consequenceThreshold": 3,
    "maxConsultationsPerTurn": 1
  }
}
```

All seven settings and defaults:

| Setting | Default | Accepted values |
| --- | --- | --- |
| `advisor.model` | Inherit the Executor model | `"inherit"` or a `providerID/modelID` reference |
| `advisor.timeoutMs` | `300000` (5 minutes) | Positive integer up to `2147483647` |
| `routing.mode` | `"off"` | `"off"`, `"observe"`, or `"active"` |
| `routing.models` | `["jev-1.13-free", "jev-1.13"]` | Non-empty array of ordered model IDs |
| `routing.advisorWouldHelpThreshold` | `0.7` | Number from 0 to 1 |
| `routing.consequenceThreshold` | `3` | Number from 0 to 4 |
| `routing.maxConsultationsPerTurn` | `1` | Positive integer |

Omit any setting to use its default. Malformed JSON, unknown keys, and invalid
values produce configuration errors; they do not silently fall back to defaults.
Do not put credentials in this file.

## Context, storage, and limits

Both explicit and automatic consultations use the selected Advisor model's
advertised limits from OpenCode's model catalog. The reserve is
`max(contextLimit * 0.25, outputLimit)` with no rounding or floor; the input
budget is `min(inputLimit ?? infinity, contextLimit - reserve)`. This is an
estimate, not a provider guarantee.
When the captured context does not fit, the plugin keeps whole entries by
priority: system instructions and task constraints, current user turn, current
assistant/tool state, compaction/checkpoint entries, then history. Oversized
entries are skipped and selection continues with later entries. The plugin does
not summarize, truncate, or otherwise compress them. Hidden assistant reasoning
is excluded; media is represented by metadata, not its contents. An omission
marker tells the Advisor when context was left out. The final estimated prompt,
including mandatory instructions and any marker, must fit the budget.

If model limits are missing or the prompt framing cannot fit, automatic review
is skipped and the Executor proceeds. The explicit tool returns an error instead.
`advisor.timeoutMs` is a soft deadline: `ctx.generate.text` has no cancellation
signal, so the plugin stops waiting after the deadline, but the underlying
stateless generation may continue. Automatic timeouts fail open; explicit
timeouts are shown in the tool result. Jev routing has a separate, abortable
5-second caller deadline. Transport, provider-internal, and unknown-provider
errors retry the same model at most once; quota and rate-limit errors fall back
to the next configured model; other error classes fail open without another
attempt. `x-should-retry: true` forces a same-model retry; `false` prevents that
retry but does not prevent quota/rate-limit fallback. An Authentication failure
on the public bearer marks that Jev model ineligible for the current session;
the configured model list is unchanged. These Jev rules do not provide an
alternate Advisor model.

Successful automatic reviews are committed before delivery to bounded
plugin-owned per-session history, not a general conversation database. Later
explicit consultations and active-mode requests can include retained reviews.
Before compaction, the plugin supplies them as privileged system context. It
retires only captured records whose IDs and exact advice text are found in a
successful compaction result; failed or unverified compactions leave them
available. Automatic review needs host storage and available history capacity;
when either is unavailable, the plugin skips the review rather than deliver an
unretained result or discard older records. Session deletion clears its retained
history.

When storage and RPC are available, `experimental.auto-advisor` exposes only
read-only methods:
`telemetry.query({ after?, limit? })` and `telemetry.event({ seq })`; the query
returns `{ events, next? }`, and the event lookup returns one event or `null`.
Telemetry records routing and delivery metadata, model/latency/outcome details,
and context-fit counts. It does not store the captured transcript or Advisor
response. Successful advice is kept separately in bounded plugin-owned history
for continuity. The optional TUI uses the distinct
`experimental.auto-advisor.review` RPC, with `status({ sessionID })` and
`review.started` / `review.finished` lifecycle events; this surface contains only
status and final advice, not Advisor confidence.

## Optional TUI

OpenCode V2.0.21 can discover the package's TUI entrypoint from the configured
server package root; the server runtime itself loads only the server entrypoint.
The TUI plugin has the distinct ID
`capybearista.opencode-auto-advisor-tui`.
The TUI adds:

- `Auto-Advisor reviewing` in the footer during an actual automatic Advisor
  generation.
- A transient `✓ Auto-Advisor finished` status for about 2.5 seconds after success.
- The latest completed automatic advice above the composer. A newer successful
  review replaces it.

The TUI shows final advice only. It does not add chat rows, expose inputs,
reasoning, routing probabilities, or telemetry, or change the composer input.
The lifecycle RPC has separate start/finish events and status snapshots so the
TUI can reconstruct current status. OpenCode 2.0.21 supports reconnecting to the
same endpoint; replacing a managed endpoint, port, or auth requires a TUI
restart because the SDK client is captured at setup. Visual behavior at narrow
terminal widths, with long advice, and alongside the Executor response still
needs manual checking.

To disable only this TUI plugin, use its plugin ID in `cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["-capybearista.opencode-auto-advisor-tui"]
}
```

The negative string is a TUI plugin removal directive by ID, not a package
specifier or an object-form plugin entry.

## Install from this checkout

For this repository's local checkout, put the following in an `opencode.json`
located at the repository root. The directory target is the package root, not
`server.js` or a file under `dist/`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./packages/opencode-auto-advisor"]
}
```

The package is still version `2.0.0` and is not available from npm. First
publication must use the repository-approved bootstrap after final validation,
manual checks, and merge; it publishes `2.0.0` without an artificial patch
Changeset. That bootstrap/release operation is not approved or implemented in
this pass. Later releases use normal Changesets. Until then, use the local
directory target above.

## Requirements and development

- OpenCode V2; V1 is not supported.
- `@opencode/plugin` and `@opencode/ai` peer dependencies are pinned to `2.0.21`.
- The optional TUI uses `@opentui/core` and `@opentui/solid` `>=0.5.14`, and
  `solid-js` `>=1.9.0`.

From this package directory:

```bash
bun run build      # compile server and TUI entrypoints
bun test           # run package tests
bun run typecheck  # type check
bun run lint       # Biome check
bun run smoke      # build and load the built server entrypoint
```

The build bundles the server implementation, including the Zen adapter, into
`dist/index.js`, which the package-root `server.js` loads. It does not produce a
runtime `dist/zen-evaluation.js` file. The TUI is bundled separately as
`dist/tui.js`; the server entrypoint does not import TUI code.

## Focused manual checks

Use a separate config directory when testing; do not change a regular OpenCode
profile. The following are checks to perform, not a completion report:

The [focused manual procedure](../../docs/plans/opencode-auto-advisor-manual-test.md)
provides isolated setup, inspection commands, and all 18 acceptance scenarios.

1. Load the built package by its directory target. Confirm the zero-argument
   `advisor()` tool is available in an eligible root session and hidden when the
   native `advisor` permission denies it; confirm a parented child is ineligible.
2. With `routing.mode` set to `off`, confirm explicit consultation still works
   and there is no automatic routing. In `observe`, verify the Jev request and
   telemetry without an Advisor call or automatic advice delivery; shared
   advisor-tool guidance may still be present in the request.
3. In `active`, exercise an opportunity that passes both thresholds. Inspect the
   actual provider request: advice must be in the privileged system prompt, not
   a lower-authority system-update tail, user message, or fake tool result. Check
   that a failed review leaves the Executor moving and does not switch Advisor
   models.
4. Verify accepted advice remains available on a later turn and through
   compaction; only exact advice proven absorbed by successful compaction should
   retire. Check the TUI's reviewing/success status and final-advice panel, plus
   narrow-width and long-advice rendering.

Final automated gates and manual wire/UI checks are still pending. The first
publication must wait for those checks and merge. A release check can report
HTTP 404 for a never-published package; that is expected before first publish.

Not part of this release: cancellable Advisor generation, an opt-in for hidden
reasoning, more aggressive tool/media compression, semantic compaction, a
Decisions API, Advisor-model fallback, or routing benchmarks. These remain
post-release work, not available settings.

## License

MPL-2.0
