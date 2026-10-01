# @capybearista/opencode-auto-advisor

OpenCode V2 server plugin that provides an independent Advisor for the Executor:

1. **Explicit consultation** — the Executor calls a zero-argument `advisor` tool.
2. **Automatic consultation** — an experimental routing layer consults the same
   Advisor at safe pre-provider session boundaries.

**Status: Phase 2 (#50).** Explicit consultation is implemented: the
zero-argument `advisor` tool captures the Executor's session context, consults a
fresh, stateless Advisor through `ctx.generate.text`, and returns the advice.
The routing domain is implemented as well: one `context` hook observer derives
the canonical captured state once from the assembled request, fingerprints
primary dispatches, applies the deterministic threshold policy, and accounts a
per-turn consultation budget. Routing and consultation consume separate
projections of that state (see [State representations](#state-representations));
no single shared serialized transcript is sent to both. `observe` evaluates
through the Zen System One adapter and persists bounded telemetry; `active`
additionally consults the Advisor and injects accepted advice into the same user
turn as a system-role message through the `context` hook. The automatic
consultation is model-aware: it resolves the selected Advisor model's advertised
context limits through the host's own model catalog and fits the Advisor
consultation projection into the derived input budget, disclosing any omission
with an internal marker and telemetry diagnostics; explicit `advisor()` stays
unbounded by that budget. The package is **not published yet** and carries no
release changeset. See
[`../../docs/plans/opencode-auto-advisor.md`](../../docs/plans/opencode-auto-advisor.md)
for the governing plan.

## State representations

One assembled hook request is normalized once into the rich **canonical captured
state**; the fingerprint, the Zen router, and the Advisor each consume their own
derivation of it. No single shared serialized transcript is passed to both
routing and the Advisor. `captureAssembledRequest` (the live hook request), the
durable capture (`captureSessionHistory`), and `mergeExplicitConsult` (which
composes the two) are the only valid canonical-state constructors; every
derivation below trusts that capture-normalized input and never builds or
re-normalizes entries itself.

- **Canonical captured state** — the full material Executor request: system
  instructions, user/assistant text, tool calls/results/errors, compaction
  markers, state markers, and sanitized media placeholders. Consumers: every
  derivation below. Bounds: normalized and sanitized at capture (media is
  metadata-only, URI query strings and fragments are stripped); bounded by the
  assembled request itself.
- **Fingerprint projection** — a SHA-256 digest over the full canonical material
  state with every advisor-origin block excluded regardless of `inFlight`,
  `inFlight` normalized to `false`, and `idle` markers dropped. Consumer:
  routing opportunity gating, which suppresses unchanged states. Bounds:
  fixed-size digest; the preimage is never persisted.
- **Jev routing projection** — a compact structured state
  (`{objective, currentTurn, recentHistory, omittedHistoryTurns, executor}`)
  derived from the canonical state. Consumer: the Zen/System One classifier
  behind the `AdvisorRouter` seam. Bounds: internal `JEV_MAX_*` caps; omitted
  history is reported, never silently dropped. By design it carries text plus
  tool activity only: assistant reasoning, media blocks, and state markers are
  excluded, so a router miss is investigated against that contract rather than
  assumed projection loss.
- **Advisor consultation projection** — the rich canonical transcript fitted to
  the selected Advisor model's input budget by whole-entry priority retention,
  with an omission marker and compact diagnostics when anything is dropped.
  Consumers: automatic consultation (`active`) with an input budget, explicit
  `advisor()` without one. Bounds: automatic = model-advertised input budget;
  explicit = unbounded by design (user-invoked).

## Configuration

Optional global JSON at `<config dir>/opencode/auto-advisor.json`, where the
config directory resolves as `OPENCODE_CONFIG_DIR`, else `XDG_CONFIG_HOME`,
else `<home>/.config`. A missing file means all defaults; invalid values are
configuration errors, never silent fallbacks. Six knobs only:

```json
{
  "advisor": { "model": "inherit" },
  "routing": {
    "mode": "off",
    "models": ["jev-1.13-free", "jev-1.13"],
    "advisorWouldHelpThreshold": 0.7,
    "consequenceThreshold": 3,
    "maxConsultationsPerTurn": 1
  }
}
```

Omitting `advisor.model` inherits the in-flight Executor model; the routing
knobs drive the automatic path.

## Routing

Automatic routing is opt-in (`"routing.mode": "off"`) and runs from a single
`ctx.session.hook("context")` observer on primary agent-loop dispatches:

- **Fingerprint** — each dispatch is fingerprinted over the full canonical
  material state, excluding every advisor-origin block (settled interactions
  included), normalizing `inFlight`, and dropping `idle` markers. An unchanged
  fingerprint is suppressed; a materially new tool result creates a new
  opportunity. The fingerprint is an independent derivation from the Jev
  routing projection, so a material change the projection omits still opens a
  new opportunity.
- **Policy** — the Advisor is consulted only when
  `advisorWouldHelp >= advisorWouldHelpThreshold` **and**
  `consequence >= consequenceThreshold`. Consequence uses a fixed 0-4 rubric:
  0 trivial, 1 minor/reversible, 2 moderate rework or user-visible mistake,
  3 serious (data loss risk, security-relevant, hard-to-reverse production
  impact), and 4 critical (irreversible harm, wide blast radius). Conservative
  defaults are 0.7 and 3.
- **Modes** — `off` only snapshots the request for explicit `advisor()`
  consults. `observe` is **not local-only**: it sends the bounded Jev routing
  projection to Zen/System One, evaluates policy hypothetically, and persists
  compact routing telemetry — with **no** automatic Advisor invocation and
  **no** Executor-context mutation. `active` additionally consults the Advisor
  and injects accepted advice into the current dispatch as a system-role message
  (prefixed `[Auto Advisor automatic advice]`), reinjecting it on continuations
  within the same user turn.
- **Router** — `@opencode/ai` Evaluation + System One behind the `AdvisorRouter`
  seam, evaluating the bounded Jev routing projection (never the serialized
  transcript). Two questions: a normalized boolean `advisor_would_help` (explicit
  positive/negative criteria framed on the immediate pending action) and the 0-4
  `consequence` score rubric. The ordered `routing.models` chain restarts at the
  top on every opportunity. Transient transport/generic-infrastructure failures
  retry the same model boundedly and then fail open without walking the chain;
  quota exhaustion, model-specific capacity, and rate limiting advance to the
  next model immediately; authentication, content-policy, invalid-request,
  timeout, and schema failures fail open immediately. `x-should-retry` governs
  the same-model retry decision only (case-insensitive), matching the verified
  host semantics: `false` never by itself forbids a fallback model. Every
  adapter call has a 5s caller deadline, so a hung provider call cannot hold the
  primary dispatch. When the public bearer terminally rejects a model
  (`Authentication`), that model is marked ineligible for the session and later
  opportunities skip it without a wasted round trip (same terminal record,
  `attempts: 0`); the configured chain is never mutated and the cache clears on
  session deletion. No reliable free-vs-paid pre-signal exists for System One
  models — they are absent from the host model catalog, so eligibility is
  learned from the first rejection instead.
- **Reentrancy** — routing only runs on primary `context` dispatches. Advisor
  consultation and Zen evaluation run on host paths that do not fire that hook,
  and injected advice is never persisted, so neither automatic consultations nor
  their output can recursively create routing opportunities.
- **Telemetry** — bounded plugin-owned storage (5000 events, oldest-first
  eviction) storing the routing fingerprint digest, decision, policy values,
  router model, attempts, latency, error class plus failure disposition (a
  failed automatic consultation records `ConsultationError` with a `terminal`
  disposition, distinct from the router's own Zen failure classes), the raw
  and normalized consequence with probability/confidence when provided, the
  compact advisor context diagnostics (completeness, omitted/included counts,
  estimated prompt tokens, input budget), the `skipReason` of a graceful
  model-limits skip, and the delivery outcome — never the transcript, and never
  credentials or secrets. Read-only RPC at `experimental.auto-advisor`
  (`telemetry.query`/`telemetry.event`).
- **Budget** — `maxConsultationsPerTurn` (default 1) is keyed by session and the
  last user message; a new user message resets it. In `active` mode an exhausted
  turn short-circuits before Zen evaluation, so no classifier call is made when
  consultation is impossible; `observe` keeps evaluating hypothetically. Because
  `observe` consumes the same hypothetical per-turn budget, its post-exhaustion
  `deny` decisions mirror exactly what `active` would have denied. An
  accepted automatic attempt consumes the budget even if the consultation fails.
  Explicit `advisor()` calls never consume it.
- **Context budget** — the selected Advisor model (`advisor.model` pinned, else
  the in-flight Executor model) is resolved through the host model catalog to
  its advertised `context`/`input`/`output` limits. The input budget reserves
  `max(25% of the context window, the output limit)` as generation/reasoning
  headroom plus operational safety margin (an internal constant, not a config
  knob); for example a 200k window with a 32k output limit yields a 150k input
  budget, and a 60k output limit raises the reserve to 60k. When the Advisor
  consultation projection exceeds the budget, whole entries are dropped
  lowest-priority first — system entries (instructions and system/task
  constraints), current user turn, current assistant/tool state, compaction
  context, then history oldest-first — never cutting mid-entry. A leading
  marker tells the Advisor when context was omitted, and `advisorContext`
  telemetry records completeness, omitted/included counts, estimated prompt
  tokens, and the budget. The size heuristic is approximate by design — it sums
  `stableStringify` lengths per entry plus an envelope approximation — the final
  prompt is measured post-hoc into `advisorContext` diagnostics, and a provider
  length rejection fails open. Unreachable or malformed
  model limits skip the automatic consultation gracefully
  (`skipReason: "advisor-model-limits-unavailable"`) without consuming the
  per-turn budget, so the Executor always proceeds. The guarantee is the fullest
  useful Executor-visible view fitting the budget, not "the complete session".
  Explicit `advisor()` stays unbounded by this budget.

Automatic failures fail open: routing, router, consultation, and injection errors
never block Executor continuation. Automatic advice is single-live-per-turn
plugin state that expires when a new user turn starts; it is injected into the
in-flight dispatch only, never persisted, and therefore can never re-trigger
routing. Non-persistence is a host contract verified on 2.0.19 (hook-time
dispatch mutations reach the model as tail content and are not written to
durable history), not a plugin-enforced invariant. Explicit `advisor()` failures
stay visible in the tool result.

## Requirements

- OpenCode V2 host (V1 is not supported)
- `@opencode/plugin` 2.0.19, `@opencode/ai` 2.0.19

## Install (intended, once published)

Server plugins register in the V2 server profile (`~/.config/opencode/opencode.json`)
under the plural `"plugins"` key:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@capybearista/opencode-auto-advisor@latest"]
}
```

A filesystem directory target resolves through the package-root `server.js`
wrapper (which re-exports `dist/index.js`), so build before registering a local
directory; do not point the config at `server.js` or `dist/index.js` directly.

## Development

From this package directory:

```bash
bun run build      # compile TypeScript to dist/
bun test           # run colocated bun tests
bun run typecheck  # type check
bun run lint       # Biome check
bun run smoke      # build, then load the built package-root server.js
```

## License

MPL-2.0
