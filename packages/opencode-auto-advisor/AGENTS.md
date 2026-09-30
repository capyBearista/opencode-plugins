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
  that fingerprints build on. Automatic advice is never persisted or serialized:
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
- Modes: `off` short-circuits before evaluating; `observe` captures, fingerprints,
  evaluates, and applies policy hypothetically with zero Advisor invocations and
  zero context mutations; `active` additionally performs the automatic
  consultation and injects accepted advice as a system-role message. No mode
  reads the session context.
  Every primary dispatch writes the request snapshot before the mode branches,
  so `off` still snapshots for explicit `advisor()` consults — the snapshot is
  the only source of hook-time system and user content.
- Fingerprint: `routingFingerprint(entries)` is a SHA-256 digest over the
  canonical fingerprint preimage emitted by `fingerprintPreimage`, which is on
  the live routing path (the router evaluates the same material entries that the
  digest covers). The preimage preserves transcript
  order and drops the in-flight advisor tool-call block, `inFlight` flags
  (normalized to `false`), and `idle` markers; state markers such as model or
  agent switches stay. Identical
  fingerprints are suppressed, so a failed or completed opportunity is never
  retried against unchanged state.
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
  out-of-range consequence is a router error.
- Budget: keyed by `(sessionID, turn key)` where the turn key is the last user
  message id; an id-less last user message falls back to
  `content:<message-index>:<content-hash>` so identical id-less turns in
  different positions stay distinct, and a dispatch with no user message falls
  back to `content:no-user:<entries-hash>` instead of sharing the empty key.
  A new user message resets the turn. The budget is checked after policy: rejected opportunities
  never consume it, and budget-exhausted opportunities are still evaluated so
  `observe` can record what `active` would have done. An accepted opportunity
  consumes one attempt whether the automatic consultation succeeds or fails;
  explicit `advisor()` never consumes. Router errors, capture failures, and
  configuration errors fail open without consuming an attempt, and the
  fingerprint is still recorded so the same state is not retried. Turn and
  budget state is an LRU keyed by session with the same cap as the snapshot
  store (64, refreshed on access, oldest session evicted), so a long-lived
  process cannot accumulate routing state across closed sessions.
- Router seam: stable code depends on
  `AdvisorRouter.evaluate(state) → { advisorWouldHelp, consequence, metadata? }`.
  The `@opencode/ai` Evaluation/System One adapter stays behind this seam in
  `zen-evaluation.ts`/`zen-router.ts`; only those `zen-*.ts` files may import
  evaluation types (enforced by `router.test.ts`), `advice-delivery.ts` may
  import the host `Message` constructor, and `index.ts` is the only
  composition point. The adapter resolves auth through
  `ctx.integration.connection.active("opencode")` + `resolve` and falls back to
  the public bearer exactly like the host's own provider plugin; it never reads
  key files or invents env-var contracts. `SystemOne.model` appends `/systemone`
  itself — configure the `…/zen/v1` base, not the full endpoint. Official V2 docs
  expose no Evaluation/System One API or changelog, so verify Zen behavior
  against opencode source and the installed `@opencode/ai` types, never docs.
- Zen chain: each opportunity restarts from the top of `routing.models`. A
  retryable class (RateLimit/ProviderInternal/Transport) retries up to
  `MAX_ATTEMPTS_PER_MODEL` with backoff, then advances the chain; QuotaExceeded
  advances immediately; Authentication/ContentPolicy/InvalidRequest/Timeout and
  other terminal classes fail open for the opportunity without consuming budget
  (`RouterError.failure` carries model/attempts/errorClass into telemetry).
  `x-should-retry` overrides both directions (header lookup is
  case-insensitive). Continuous System One scores are
  rounded onto the discrete 0-4 rubric before `normalizeAssessment`. Every
  adapter call carries a caller deadline (`ZEN_CALL_TIMEOUT_MS`, 30s) that
  aborts the evaluation and surfaces a classified `Timeout` AIError, so a hung
  provider call cannot hold the primary dispatch.
- Telemetry: `ctx.storage` keys `head` + `evt:<zero-padded seq>`; cap 5000 with
  oldest-first eviction, writes serialized in-process and fail-open, reads
  paginated within the host scan limit (≤1000). Events store the fingerprint
  digest, decision, policy snapshot, router model/attempts, latency, error class,
  advisor model, and delivery outcome — never transcript text. The head is
  reserved before the event write, so a crash can never reuse a sequence; an
  event write that fails after the head write leaves a permanent sequence hole
  (sparse telemetry, never duplicate ids) and can advance the eviction window
  past the missing event. RPC
  `experimental.auto-advisor` exposes only `telemetry.query` and
  `telemetry.event` (no mutation surface).
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
- Known limits carried forward: advisor prompts embed the full transcript with no
  size bound — shipping `active` as opt-in experimental on the `off` default is
  the accepted risk, and a truncation policy is required before recommending
  `active` broadly;
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
