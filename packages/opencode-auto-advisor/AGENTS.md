# opencode-auto-advisor — OpenCode plugin

**Technology**: TypeScript / OpenCode V2 Plugin (`@opencode/plugin` 2.0.19)
**Entry Point**: `server.js` (package root) → `src/index.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)

## Quick Reference

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `bun run build`     | Compile TypeScript         |
| `bun run typecheck` | Type check                 |
| `bun run lint`      | Validate without modifying |
| `bun test`          | Run tests                  |
| `bun run smoke`     | Build + built-entry smoke  |

## Status

Phase 2 (#50) implemented: routing consumes the live assembled request, explicit
consultations merge it with the current delta, and the automatic path runs the
full Zen/System One pipeline. `ctx.session.hook("context")` canonicalizes the
request the host is about to dispatch (`event.system`, `event.messages`,
`event.model`) into a bounded per-session snapshot, fingerprints that request
with a SHA-256 digest, applies the deterministic policy, and accounts the
per-turn consultation budget. The `AdvisorRouter` seam is now backed by the
`@opencode/ai` Evaluation + System One adapter with the ordered
`routing.models` chain, bounded per-model retries, and quota/terminal failure
classification. `observe` persists bounded digest-only telemetry through
`ctx.storage` and exposes it read-only over RPC (`experimental.auto-advisor`);
`active` additionally consults the Advisor and injects accepted advice into the
same turn as a system-role message through the `context` hook, with
single-live-per-turn lifetime and reinjection on continuations so the advice
never re-triggers routing. Explicit zero-argument
`advisor()` works end to end — strict global configuration, Executor-model
inheritance, and a stateless `AdvisorService` over `ctx.generate.text`. Add a
Changeset only when the package becomes releasable.

Remediation phase A: routing and automatic consultation no longer consume the
raw full transcript. The Zen router sends a bounded structured Jev projection
derived from the canonical captured state; the fingerprint covers the full
canonical material state with advisor-origin blocks excluded regardless of
`inFlight`; and both consultation paths route through the Advisor projection
seam where model-aware fitting lands next.

Remediation phase B: `active` no longer pays classifier latency once the turn
budget is exhausted, the `advisor_would_help` boolean carries explicit positive
and negative criteria framed on the immediate pending action, the raw
consequence score and probability/confidence metadata survive normalization into
telemetry, the Zen call deadline is 5s, and the Zen chain distinguishes
same-model retry (transient infrastructure), model fallback (quota/capacity/
rate-limit), and fast fail-open (auth/config/schema/programming) with the
verified host semantics of `x-should-retry`.

Remediation phase C: the automatic consultation is model-aware. The selected
Advisor model (`advisor.model` pinned, else the captured Executor model) is
resolved through the host's own model catalog (`ctx.model.list()`) to its
advertised `limit.context`/`limit.input`/`limit.output`; a deterministic
priority retention pass fits the canonical transcript into the derived input
budget, and the omission is disclosed to the Advisor with an internal marker
plus compact diagnostics in telemetry. Unreachable or malformed model limits
skip the automatic consultation gracefully without consuming the per-turn
budget, and explicit `advisor()` remains unbounded by this budget. The rich
Advisor projection is built lazily: only after an opportunity is accepted by
policy and has budget remaining, and never in `observe`.

Remediation phase D: a failed automatic consultation is recorded in telemetry
as `ConsultationError` with a `terminal` disposition instead of being mislabeled
as `RouterError`; the router-error path keeps its Zen class and resolved
disposition. The durable docs also distinguish the four state representations
(canonical captured state, fingerprint projection, Jev routing projection,
Advisor consultation projection) so no reader assumes one shared serialized
transcript feeds both routing and the Advisor, and they state plainly that
`observe` sends the bounded Jev routing projection to Zen and is not
local-only.

Remediation phase E: the context hook is fail-open end to end — an unexpected
throw from snapshot capture, the routing domain, delivery, or telemetry is
swallowed and the primary dispatch proceeds unmutated. An exhausted fallback
chain normalizes its terminal throw to a `terminal` disposition while preserving
model, error class, and total attempts. Because the host catalog exposes no
free-vs-paid pre-signal for System One models, a paid model that terminally
rejects the public bearer is instead cached as ineligible for that session:
later opportunities skip it without attempting (same terminal `Authentication`
record, `attempts: 0`), the configured `routing.models` chain is never mutated,
and the cache clears on `session.deleted`.

## Configuration

- Global-only strict JSON at `<config dir>/opencode/auto-advisor.json`. The
  config directory resolves as `OPENCODE_CONFIG_DIR`, else `XDG_CONFIG_HOME`,
  else `<home>/.config`, mirroring OpenCode's own global roots on every
  platform instead of hard-coding a Unix path.
- Sparse: a missing file yields all defaults, a missing key yields that key's
  default, and a valid explicit value wins. Malformed JSON, unknown keys, and
  invalid values raise `ConfigError` naming the offending key and never fall
  back silently. Secrets are never read from this file.
- Six knobs only: `advisor.model`, `routing.mode`, `routing.models`,
  `routing.advisorWouldHelpThreshold`, `routing.consequenceThreshold`,
  `routing.maxConsultationsPerTurn`.

Routing defaults (conservative; finalized by 1C):

| Knob | Default | Rationale |
| --- | --- | --- |
| `advisor.model` | omitted | Inherit the in-flight Executor model for that consultation |
| `routing.mode` | `"off"` | Automatic routing stays opt-in until calibrated |
| `routing.models` | `["jev-1.13-free", "jev-1.13"]` | Plan default: use free Zen capacity first, paid second |
| `routing.advisorWouldHelpThreshold` | `0.7` | Demands fairly strong signal; Jev guidance treats concentrated distributions as confident and advises review below ~0.8, so `0.7` keeps automatic review conservative |
| `routing.consequenceThreshold` | `3` | Reserves automatic review for serious/critical consequences on the 0-4 rubric |
| `routing.maxConsultationsPerTurn` | `1` | One automatic consultation per turn bounds cost and latency |

## Architecture

```text
server.js               # Package-root V2 entry, re-exports dist/index.js
scripts/smoke-built.ts  # Built-artifact smoke: id, tool contract, consult, context hook, cleanup
src/
├── index.ts            # Plugin.define default export + registerPlugin wiring
├── config-types.ts     # Knob types, defaults, ConfigError
├── config-parse.ts     # Strict sparse-config validation
├── config.ts           # Config-directory resolution + file loading
├── context.ts          # Durable session history → captured, serialized context
├── request.ts          # Assembled model request → captured routing state
├── request-serialize.ts  # Assembled-request serializer; unknown part types become type-name-only markers (no payload) so future host types alter the fingerprint instead of colliding
├── canonical.ts        # CanonicalState: the rich, capture-normalized entry form every derivation reads
├── material.ts         # Advisor-origin block exclusion shared by the fingerprint and projections
├── jev-projection.ts   # Bounded structured Zen routing state (JEV_MAX_* caps) built from canonical state
├── advisor-projection.ts # Advisor consultation projection: model-aware priority fitting + diagnostics
├── model-limits.ts     # Host model-catalog lookup → advertised limits + reserve/budget math
├── consult.ts          # Explicit merge: captured request + current-turn delta
├── snapshot-store.ts   # Bounded, turn-keyed per-session request snapshots
├── messages.ts         # Host message/tool shapes derived from @opencode/plugin types
├── serialize.ts        # Canonical deterministic transcript serializer (durable form)
├── serialize-assistant.ts
├── stable.ts           # Key-sorted stringify
├── digest.ts           # SHA-256 helper
├── media.ts            # Media placeholders; raw bytes never leave this module
├── advisor-service.ts  # Fresh/stateless consultation service
├── advice-delivery.ts  # System-role advice injection + single-live-advice lifetime
├── zen-auth.ts         # Plugin-safe Zen credential resolution (integration connection)
├── zen-errors.ts       # Failure classification: retry / fallback / terminal
├── zen-questions.ts    # Boolean + 0-4 score questions and answer normalization
├── zen-evaluation.ts   # @opencode/ai Evaluation + SystemOne runtime (adapter-internal)
├── zen-router.ts       # Ordered chain, bounded retry, restart-at-top
├── telemetry-types.ts  # Bounded event/store/RPC-facing types
├── telemetry.ts        # 5000-event digest-only store with oldest-first eviction
├── telemetry-rpc.ts    # Read-only telemetry.query / telemetry.event handlers
├── turn-store.ts       # Per-session turn fingerprint + budget state
├── routing-types.ts    # AdvisorRouter seam, decisions, 0-4 consequence anchors
├── router.ts           # Router result normalization (clamp/reject)
├── fingerprint.ts      # Routing fingerprint digest + preimage composition
├── routing.ts          # Modes, opportunity gating, policy, bounded per-turn budget
├── routing-observer.ts # ctx.session.hook("context") wiring, delivery, telemetry
└── *.test.ts           # Colocated bun tests
```

- `src/index.ts` — default export is
  `Plugin.define({ id: "capybearista.opencode-auto-advisor", setup })`;
  `registerPlugin(context)` registers the zero-argument `advisor` tool through
  `context.tool.transform`, registers the routing observer, and returns an
  idempotent dispose function that disposes the hook before the tool. The plugin
  creates one shared `AdvisorService` per setup; the tool and the automatic path
  both resolve through it, and `buildAdvisorService` is the shared seam.
- Three distinct context domains, each with its own explicit types:
  `captureSessionHistory` serializes durable `ctx.session.context` messages;
  `captureAssembledRequest` serializes the live hook request; `mergeExplicitConsult`
  combines a turn-matched request snapshot with the persisted delta of the
  in-flight assistant message. Only the merged context feeds explicit `advisor()`;
  routing consumes only the assembled request. The assistant message that
  carries the `advisor()` call is marked `inFlight: true`, so same-turn assistant
  text before the call survives capture. Compaction entries include checkpoint
  provenance; the provider-native checkpoint blob is omitted.
- `mergeExplicitConsult` relies on the invariant that a turn-matched snapshot
  already spans the durable prefix through the current user turn — the assembled
  request carries the durable messages, so only the durable delta from the
  in-flight message onward is appended and no earlier turn is duplicated. The
  invariant is documented rather than re-verified because hook-time mutations
  can legitimately differ from the durable text; the turn-key equality check is
  the guard that keeps a stale snapshot out of the merge.
- Turn-key logic is shared: capture and explicit lookup both go through the single `contentTurnKey` helper (`turnKeyFor` / `turnKeyForHistory` in `request.ts`) — a key-format change must land in both paths together or snapshots become write-only.
- `serializeAdvisorContext` and `stableStringify` are pure, deterministic
  (sorted keys) exports, so all three serializers share one canonical entry form
  that fingerprints build on, and the routing and Advisor projections derive
  from. Automatic advice is never persisted or serialized:
  it is injected into the in-flight dispatch only, so no serializer needs an
  advisor-origin escape hatch.
- Media (images, audio, video, documents, unknown) becomes metadata placeholders
  with `inspected: false`; base64 payloads and provider-native blobs never reach
  the prompt. URI sources drop query strings and fragments, local paths reduce
  to a basename, and unrecognized MIME types stay `unknown` instead of being
  mislabeled as documents. `describeMedia` sanitizes `name`/`filename` the same
  way (query/fragment stripped, path reduced to a leaf) before every serializer
  sees it, so a filename can never smuggle directory paths or URL secrets into
  the transcript.
- Explicit-consultation failures — session read, configuration, or generation —
  are returned as a visible `Auto Advisor consultation failed: …` tool result
  with `metadata.error`; they are never thrown past the tool boundary.

## State representations

`captureAssembledRequest` normalizes the assembled hook request once into the
rich **canonical captured state**; every other representation is a separate
derivation of it, and no single shared serialized transcript is passed to both
routing and the Advisor. `captureAssembledRequest`, the durable capture
(`captureSessionHistory`), and `mergeExplicitConsult` (which composes the two)
are the only valid `CanonicalState` constructors; every derivation trusts their
capture-normalized input and never builds or re-normalizes entries itself.

- Canonical captured state — the full material Executor request
  (`CanonicalState`): system instructions, user/assistant text, tool
  calls/results/errors, compaction markers, state markers, and sanitized media
  placeholders. Consumers: all three derivations below. Bounds: normalized and
  sanitized at capture (media is metadata-only, URI query strings and fragments
  are stripped); bounded by the assembled request itself.
- Fingerprint projection — a SHA-256 digest over the full canonical material
  state, with every advisor-origin block excluded regardless of `inFlight`,
  `inFlight` normalized to `false`, and `idle` markers dropped. Consumer:
  routing opportunity gating, which suppresses unchanged states. Bounds:
  fixed-size digest; the preimage is never persisted.
- Jev routing projection — a compact structured state
  (`{objective, currentTurn, recentHistory, omittedHistoryTurns, executor}`).
  Consumer: the Zen/System One classifier behind the `AdvisorRouter` seam
  (`observe` and `active` both send it; `off` sends nothing). Bounds: internal
  `JEV_MAX_*` caps; omitted history is reported as `omittedHistoryTurns`.
- Advisor consultation projection — the rich canonical transcript fitted to the
  selected Advisor model's input budget by whole-entry priority retention, with
  an omission marker and compact diagnostics when anything is dropped.
  Consumers: automatic consultation (`active`) with an `inputBudget`; explicit
  `advisor()` without one. Bounds: automatic = model-advertised input budget;
  explicit = unbounded by design (user-invoked).

## Routing

- Boundary: exactly one `ctx.session.hook("context", …)` observer. On
  `@opencode/plugin` 2.0.19 the host only fires this hook for primary agent-loop
  dispatches (compaction, title, and generate dispatches have their own hook
  names), so a payload without `kind` is treated as primary; a payload that
  carries any other `kind` is skipped defensively.
- Routing input is the assembled request the host is about to dispatch, read
  from the hook event (`system`, `messages`, `model`), never a second
  `session.context()` read of persisted history. Hook-time mutations therefore
  affect routing state. The same request is captured into a bounded store
  (LRU across sessions, one snapshot per session) keyed by
  `(sessionID, last-user-message-id)`; a snapshot is only reused while its turn
  key still matches the durable history, so stale snapshots never attach to a
  later consultation. Unreadable dispatches fail open without throwing.
- Modes: `off` short-circuits before evaluating. `observe` is **not
  local-only**: it captures, fingerprints, sends the bounded Jev routing
  projection to Zen/System One, applies policy hypothetically, and persists
  compact routing telemetry, with zero automatic Advisor invocations and zero
  Executor-context mutations. `active` additionally performs the automatic
  consultation and injects accepted advice as a system-role message. No mode
  reads the session context.
  Every primary dispatch writes the request snapshot before the mode branches,
  so `off` still snapshots for explicit `advisor()` consults — the snapshot is
  the only source of hook-time system and user content.
- Canonical state: `captureAssembledRequest` produces the rich canonical entry
  form (`CanonicalState` in `canonical.ts`) — media and URIs are normalized and
  sanitized exactly once at capture, and every downstream derivation reads this
  full-detail state.
- Fingerprint: `routingFingerprint(canonical)` is a SHA-256 digest over the
  canonical fingerprint preimage emitted by `fingerprintPreimage`. The preimage
  preserves transcript order, normalizes `inFlight` to `false`, drops `idle`
  markers, and excludes every `advisor`-named tool-call/result/error block
  regardless of `inFlight` (settled/completed interactions included; assistant
  and tool entries alike). An entry whose blocks were all advisor-origin is
  dropped with them; unrelated blocks in the same message always stay. State
  markers such as model or agent switches stay. The fingerprint is a separate
  derivation from the Jev projection, so a material change the projection omits
  still opens a new opportunity. Identical
  fingerprints are suppressed, so a failed or completed opportunity is never
  retried against unchanged state.
- Jev routing projection: the Zen backend derives a deliberately compact,
  structured state from the canonical entries (`buildJevRoutingProjection` in
  `jev-projection.ts`) and sends it as the Evaluation `state` — never the
  serialized transcript. Priority order: current user objective (with sanitized
  media hints), current-turn assistant text, current-turn tool calls/results/
  errors (advisor-origin excluded), the most recent settled turns for reference
  resolution, and minimal executor agent/model metadata; older turns are omitted
  and reported as `omittedHistoryTurns`. By design the projection carries text
  plus tool activity only: assistant reasoning blocks, media blocks, and state
  markers are excluded, so a router miss is investigated against that contract
  rather than assumed projection loss. Every cap is an internal `JEV_MAX_*`
  constant, never configuration. The projection lives on the Zen/Jev side of
  the `AdvisorRouter` seam: the generic boundary only carries canonical state,
  so no Jev assumption leaks into `routing.ts` or `routing-types.ts`.
- Advisor projection seam: `buildAdvisorProjection(canonical, options)` in
  `advisor-projection.ts` is the single place the rich Advisor consultation
  context is built, used by both the automatic path (`routing.ts`) and the
  explicit merge (`consult.ts`). With no `inputBudget` it returns the full
  canonical transcript (`serializeAdvisorContext`) and no diagnostics — the
  explicit path stays unbounded because it is user-invoked. With an
  `inputBudget` it fits the transcript by priority and reports
  `AdvisorContextDiagnostics` (`complete`, `omittedEntries`, `includedEntries`,
  `estimatedTokens`, `inputBudget`); callers must not build transcripts
  themselves. The rich projection is constructed lazily: `routing.ts` builds it
  only after policy acceptance and a free per-turn budget, never in `observe`
  and never for rejected/denied opportunities (`project` is the injectable
  builder seam the tests assert that with).
- Model-aware budget: the selected Advisor model (`resolveAdvisorModel`:
  `config.advisor.model` else the captured executor model) is resolved through
  the host's own model catalog to its advertised `limit` fields. The lookup is
  `ctx.model.list()` in the V2 promise plugin API, which the host serves from
  `Model.Service.available()` (enabled models) as `{ location, data: Model.Info[] }`;
  entries match by `modelID` (or `id`) plus `providerID`, and the limit shape is
  `{ context: int, input?: int, output: int }` (`@opencode/schema/model`). No
  local model-capability table exists. The resolver returns `undefined` on a
  missing catalog, a failed call, an unknown model, or malformed limits, and the
  automatic path then returns `skip` with `skipReason:
  "advisor-model-limits-unavailable"` without consuming the per-turn budget —
  fail open, no consultation, Executor proceeds, telemetry records the cause.
  Because `@opencode/client` is not installed in this package, `index.ts`
  accesses the catalog through a narrow structural `ModelCatalog` with a
  runtime function guard instead of the unresolved host type.
- Input budget: `reserve = max(floor(context_limit * ADVISOR_RESERVE_FRACTION), output_limit)`
  with internal `ADVISOR_RESERVE_FRACTION = 0.25` (no config knob), then
  `input_budget = min(input_limit ?? context_limit - reserve, context_limit - reserve)`;
  a non-positive budget is treated as unusable limits and fails open. The
  reserve is generation/reasoning headroom plus operational safety margin for a
  single-shot consultation — it is not a claim that any model degrades at a
  particular fill level. Worked examples: context 200k / output 32k → reserve
  50k → input 150k; context 200k / output 60k → reserve 60k → input 140k.
- Retention and size: when the canonical entries exceed the input budget,
  `buildAdvisorProjection` drops whole entries lowest-priority first —
  (1) system entries (instructions and system/task constraints), (2) current
  user turn, (3) current assistant/tool state, (4) compaction/checkpoint
  entries, (5) history — and never cuts mid-entry, so every included tool
  call/result and JSON object stays complete. A tier that cannot
  be fully included stops all lower tiers, so a dropped entry is never replaced
  by lower-priority content. History is offered newest-first, so the oldest
  entries are dropped first. The size heuristic is deterministic and internal:
  `estimateTokens(text) = round(length / 4)` characters per token, mirroring the
  host's own `Token.estimate`; it is pinned by tests, not configurable. It is
  approximate by design — the fit sums `stableStringify` lengths per entry plus
  an envelope approximation, and the final prompt is measured post-hoc into the
  `advisorContext` diagnostics instead of being trusted from the estimate.
- Omission marker and diagnostics: when anything is omitted, the transcript
  gains a leading structured marker entry (`role: "marker"`,
  `type: "context-omitted"`, detail `ADVISOR_OMISSION_MARKER`) stating that
  earlier/lower-priority Executor context was omitted for the Advisor model's
  context budget. The marker appears only when reduction occurs; the mandatory
  marker can push the estimate marginally past the budget within the reserve.
  Compact diagnostics travel as additive fields (`advisorContext` on the
  decision and the telemetry event, plus `skipReason`) and store counts and
  estimates only — omitted content is never persisted anywhere. The guarantee is
  the fullest useful Executor-visible view fitting the budget, never "the
  complete session": the host may already have compacted history, and media is
  metadata placeholders by design. If the provider still rejects the fitted
  prompt for length, the consultation fails open (`action: "fail"` with the
  built diagnostics), nothing is injected, and the Executor continues.
- Consequence anchors (the `consequence` router answer is an integer 0-4 on this five-level rubric; the Eval client enforces `0..n−1` dynamically, so any future rubric change must keep exactly five levels to preserve the 0-4 contract):

  | Level | Summary | Guidance |
  | --- | --- | --- |
  | 0 | trivial | No meaningful consequence; proceeding without review costs nothing |
  | 1 | minor | A minor inconvenience that is easily reversed |
  | 2 | moderate | Moderate rework or a mistake visible to the user |
  | 3 | serious | Data loss risk, security-relevant, or hard-to-reverse production impact |
  | 4 | critical | Irreversible harm with a wide blast radius |

- Policy: `consult = advisorWouldHelp >= routing.advisorWouldHelpThreshold AND
  consequence >= routing.consequenceThreshold`, read from live configuration for
  every opportunity. `advisorWouldHelp` is clamped to `[0, 1]` for finite values;
  NaN and ±Infinity are rejected as router errors; a non-integer or
  out-of-range consequence is a router error. The `advisor_would_help` boolean
  is framed on the Executor's immediate pending action — not overall project
  difficulty — with explicit positive criteria (independent review could change
  that next action or catch a non-obvious correctness, security, data-integrity,
  concurrency, compatibility, or design problem) and explicit negative criteria
  (routine, mechanical, read-only, easily reversible, already well-supported, or
  low-value-for-independent-review actions).
- Budget: keyed by `(sessionID, turn key)` where the turn key is the last user
  message id; an id-less last user message falls back to
  `content:<message-index>:<content-hash>` so identical id-less turns in
  different positions stay distinct, and a dispatch with no user message falls
  back to `content:no-user:<entries-hash>` instead of sharing the empty key.
  A new user message resets the turn. The budget is checked after policy: rejected opportunities
  never consume it. `active` short-circuits before evaluation once the turn is
  exhausted — no classifier call is made when consultation is impossible — while
  `observe` keeps evaluating hypothetically past the limit so calibration data
  still records what `active` would have done; because `observe` consumes the
  same hypothetical per-turn budget, its post-exhaustion `deny` decisions mirror
  exactly what `active` would deny. An accepted opportunity
  consumes one attempt whether the automatic consultation succeeds or fails;
  explicit `advisor()` never consumes. Router errors, capture failures, and
  configuration errors fail open without consuming an attempt, and the
  fingerprint is still recorded so the same state is not retried. Turn and
  budget state is an LRU keyed by session with the same cap as the snapshot
  store (64, refreshed on access, oldest session evicted), so a long-lived
  process cannot accumulate routing state across closed sessions. An identical
  dispatch after exhaustion records `suppress` (the fingerprint check runs
  before the short-circuit), not `deny` — both skip evaluation, so telemetry
  readers must not treat `suppress` as an evaluated decision.
- Router seam: stable code depends on
  `AdvisorRouter.evaluate(state) → { advisorWouldHelp, consequence, metadata? }`.
  The `@opencode/ai` Evaluation/System One adapter stays behind this seam in
  `zen-evaluation.ts`/`zen-router.ts`; only those `zen-*.ts` files may import
  evaluation types (enforced by `router.test.ts`), `advice-delivery.ts` may
  import the host `Message` constructor, and `index.ts` is the only
  composition point. The no-direct-`effect`-import guard (`router.test.ts`)
  excludes `.test.` files, so host-path validation tests may import `effect`
  while the manifest must never pin it. The adapter resolves auth through
  `ctx.integration.connection.active("opencode")` + `resolve` and falls back to
  the public bearer exactly like the host's own provider plugin; it never reads
  key files or invents env-var contracts. `SystemOne.model` appends `/systemone`
  itself — configure the `…/zen/v1` base, not the full endpoint. Official V2 docs
  expose no Evaluation/System One API or changelog, so verify Zen behavior
  against opencode source and the installed `@opencode/ai` types, never docs.
- Zen chain: each opportunity restarts from the top of `routing.models` and
  resolves every failure into one of three outcomes. `retry`
  (Transport/ProviderInternal/UnknownProvider — transient transport and generic
  infrastructure) retries the SAME model up to `MAX_ATTEMPTS_PER_MODEL` with
  backoff, then fails open without walking the chain, because a model change
  cannot plausibly resolve generic infrastructure. `fallback`
  (QuotaExceeded/RateLimit — quota exhaustion, model-specific capacity, or
  model-specific rate limiting) advances to the next model immediately.
  `terminal` (Authentication/ContentPolicy/InvalidRequest/Timeout/
  UnsupportedOperation/InvalidProviderOutput and non-AIError) fails open for the
  opportunity without walking the chain. None of the outcomes consume budget.
  An exhausted fallback chain normalizes the terminal throw to a `terminal`
  disposition, preserving the last model, error class, and total attempts.
  No reliable free-vs-paid pre-signal exists for System One models: they are
  absent from the host model catalog (`ctx.model.list()` exposes enabled models
  only, and the catalog has no `jev-1.13*` entries), and the Zen `/v1/models`
  listing marks neither free nor paid models. Eligibility is therefore learned
  at runtime: a terminal Authentication failure — the paid-model-on-public-token
  rejection verified live — marks that model ineligible in a session-scoped
  cache when the active Zen credential is the public bearer (`isPublicAuth` on
  the evaluation seam, backed by `resolveZenToken`). Later opportunities skip an
  ineligible model without attempting it and record the same terminal
  `Authentication` failure with `attempts: 0`; the configured `routing.models`
  chain is never mutated; the cache is bounded like the other session state and
  cleared on `session.deleted`; and a missing or failing public-auth probe leaves
  caching disabled (fail open). Two sharp edges: a 5xx caused by free-tier
  capacity is indistinguishable from generic infrastructure 5xx and fails open
  instead of falling back; and a model cached ineligible under the public bearer
  stays skipped until `session.deleted` even if credentials change mid-session.
  `x-should-retry` governs the same-model retry decision only, matching the host
  `isRetryable` semantics verified in opencode source
  (`packages/ai/src/provider-error.ts`, consumed by the session runner's retry
  policy): `true` forces a same-model retry on any class, `false` forbids a
  same-model retry (fallback classes still fall back, retry classes become
  terminal) and never by itself forbids a fallback model; the header lookup is
  case-insensitive. `RouterError.failure` carries model/attempts/errorClass plus
  the resolved disposition into telemetry. Continuous System One scores are
  rounded half-up onto the discrete 0-4 rubric and clamped, and the raw score,
  per-level probabilities, and confidence are preserved in assessment metadata
  and telemetry alongside the normalized value. Every adapter call carries a
  caller deadline (`ZEN_CALL_TIMEOUT_MS`, 5s) that aborts the evaluation and
  surfaces a classified `Timeout` AIError, so a hung provider call cannot hold
  the primary dispatch.
- Telemetry: `ctx.storage` keys `head` + `evt:<zero-padded seq>`; cap 5000 with
  oldest-first eviction, writes serialized in-process and fail-open, reads
  paginated within the host scan limit (≤1000). Events store the fingerprint
  digest, decision, policy snapshot, router model/attempts, latency, error class
  plus failure disposition, the raw and normalized consequence with the score
  answer's probabilities/confidence when provided, advisor model, the compact
  `advisorContext` diagnostics (completeness, omitted/included counts, estimated
  prompt tokens, input budget), the `skipReason` for a graceful model-limits
  skip, and delivery outcome — never transcript text, credentials, or secrets.
  A failed automatic consultation records `ConsultationError` with a `terminal`
  disposition; router failures keep their Zen class and resolved disposition.
  The head is
  reserved before the event write, so a crash can never reuse a sequence; an
  event write that fails after the head write leaves a permanent sequence hole
  (sparse telemetry, never duplicate ids) and can advance the eviction window
  past the missing event. RPC
  `experimental.auto-advisor` exposes only `telemetry.query` and
  `telemetry.event` (no mutation surface). The host RPC path silently strips
  event fields the schema does not declare (Effect decode discards excess
  properties instead of erroring), so every field `routing-observer.ts` can
  emit must exist as an optional schema property — verify with a
  maximal-event round-trip test through the host's real validation path, not
  by reading the schema.
- Reentrancy: the only routing trigger is the primary `context` hook. Advisor
  consultation (`ctx.generate.text`) and Zen evaluation run on host paths that
  do not fire that hook, and injected advice is never persisted, so neither
  automatic consultations nor their output can recursively create routing
  opportunities. `routing-observer.test.ts` covers the auxiliary-kind skips and
  the same-turn reinjection path.
- Delivery and lifetime: accepted `active` advice is injected into the current
  dispatch as a system-role message (`Message.system`) appended at the tail of
  `event.messages`, prefixed `[Auto Advisor automatic advice]`, so the primary
  model reads it in the system role while the cached conversation prefix stays
  warm. Never use `session.synthetic` for advice: it projects to user-role on
  the wire, presenting plugin output as principal user intent. Injection runs after capture and evaluation, so advice never enters a
  fingerprint, turn key, snapshot, or durable history. Advice is
  single-live-per-turn: every later primary dispatch in the same turn reinjects
  the live text, a newer review supersedes the older one, and a new user turn
  expires it. Injection failures fail open and are recorded with
  `delivered: false`. Both properties rest on host contracts rather than plugin
  invariants: the appended message must reach the model as dispatch-tail content
  (the verified 2.0.19 wire lowers it to a `<system-update>`-wrapped tail) and
  hook-time `event.messages` mutations must not be persisted. If a host change
  ever persisted them, prior advice would re-enter the next-turn fingerprint,
  Zen state, and advisor transcript, so capture-side filtering would have to
  come back.
- Session cleanup: there is no session-close hook, so `index.ts` subscribes to
  `ctx.event.subscribe` (`session.deleted`) and clears snapshots, turn state,
  and live advice; setup cleanup aborts the subscription and disposes RPC,
  routing, the Zen runtime, and the tool.
- Known limits carried forward: automatic consultations are fitted to the
  Advisor model's advertised budget, while explicit `advisor()` prompts still
  embed the full transcript with no size bound by design (user-invoked) —
  shipping `active` as opt-in experimental on the `off` default is
  the accepted risk, and live calibration of the 25% reserve is still required
  before recommending `active` broadly;
  `sanitizeUri` preserves http(s) path segments, so a secret embedded in a URL
  path can still reach the prompt (query strings and fragments are stripped, but
  paths are not); no-user turns fall back to durable history in real flows (the
  in-flight flag asymmetry keeps hook and durable no-user keys from coinciding) —
  changing that needs an explicit design decision, not a key-format tweak.

## V2 Install and Compatibility

- This package is **V2-only** and targets `@opencode/plugin` **2.0.19**, the
  approved plan baseline. The rest of this monorepo currently installs 2.0.2;
  do not copy this pin into the older packages without an intentional upgrade.
- Server plugins register in the V2 server profile (`~/.config/opencode/opencode.json`)
  under the plural `"plugins"` key; use `@latest` or an exact pin, never `@v2`.
- A filesystem directory target resolves through the package-root `server.js`
  wrapper, so build before registering a local directory and never point the
  config at `server.js` or `dist/index.js` directly.
- Do not use V1 `server`/`config` hook signatures, `WithInstance`, or string
  event buses. The V2 boundary is documented in
  [../../docs/v1-plugins.md](../../docs/v1-plugins.md).

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Explicit `advisor()` failures stay visible through the tool
  result returned by `registerPlugin`.
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative, with `.js` suffixes.
- Keep files under ~150 lines; split before growing past that.
- `import type` for type-only imports (Biome `useImportType` is an error).

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Mock contexts only. Config tests write fixtures to a `mkdtemp` temporary
  directory and pass an explicit `path`; the real OpenCode config directory is
  never read or written.
- Runtime smoke: `bun run smoke` loads the **built** package-root `server.js`
  (never `dist/*` directly) with a temporary `OPENCODE_CONFIG_DIR`, asserts the
  plugin id, the zero-argument tool contract, exactly one `context` hook, and the
  telemetry RPC, fires frozen primary/auxiliary dispatches in all three modes
  (routing never reads persisted history and never mutates the dispatch), then
  executes a consultation through the hook snapshot + `session.context` +
  `generate.text` and asserts the hook-time system, the captured user message,
  and the current assistant delta each appear exactly once with executor-model
  inheritance. A second registered instance with an injected router proves off
  stays inert, observe persists telemetry without consulting, and active
  consults plus injects a system-role advice message into the dispatch. Cleanup
  must dispose the hook, RPC, and tool registrations and abort the event
  subscription.
- Live verification (2.0.19): a real `opencode run --standalone` loads the built
  package, uses a local OpenAI-compatible provider stand-in, and checks that the
  context hook sees the assembled request, the merged advisor prompt contains the
  hook-only system prompt exactly once plus the current assistant delta exactly
  once, and the hook turn key matches the durable user message id. Keep probe
  fixtures in tmpdirs with private `OPENCODE_CONFIG_DIR`/`XDG_*` roots.
- The 2.0.18 probe is documented as BLOCKED by the upstream stateless-generation
  header issue (`ctx.generate.text` omitted `x-opencode-session`), not a
  context-capture failure.
- 2.0.19 assembled-request fidelity probe PASSED: an Executor called `advisor()`
  without reading repo files and the Advisor recovered repo instructions absent
  from the user prompt (merge-commit merges, retain remote branch).
- 2.0.19 in-flight delta fidelity probe PASSED: an Executor emitted a glob tool
  call with a unique nonce plus `advisor()`, the nonce existing only in the
  sibling tool-call args, and the Advisor recovered the exact nonce.
- 2.0.19 #50 runtime probe PASSED (private tmpdir `OPENCODE_CONFIG_DIR`/`XDG_*`,
  `opencode run --standalone --auto`, local OpenAI-compatible executor stand-in,
  real `opencode.ai/zen/v1/systemone` with the public bearer): `off` produced
  zero telemetry, zero advisor calls, and no advice; `observe` produced two real
  Zen evaluations with telemetry (policy, fingerprint, model, attempts, latency)
  and no advisor call or delivery; `active` produced a real Zen evaluation, an
  advisor call through the stand-in, telemetry `delivered: true`, and the
  advice landed in the same in-flight dispatch that triggered the evaluation
  (host lowers it to `<system-update>`-wrapped tail text on the wire) with
  reinjection on the tool-result continuation. The tool-result
  continuation re-evaluated and was denied by the per-turn budget, and the
  advice message never became the turn key. Read-only RPC verified live:
  `telemetry.query`/`telemetry.event` succeed, `telemetry.record` returns
  `rpc.method_not_found`, and malformed input returns `rpc.invalid_input`.

## License

MPL-2.0
