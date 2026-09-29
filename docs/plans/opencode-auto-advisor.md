# OpenCode Auto Advisor

**Status:** Implementation approved — implementation may proceed  
**Package:** `@capybearista/opencode-auto-advisor`  
**Host baseline:** OpenCode V2, initially `@opencode/plugin@2.0.18` and `@opencode/ai@2.0.18`  
**Distribution:** npm `latest`

## Goal

Create an OpenCode V2 server plugin that provides an independent Advisor through two paths:

1. **Explicit consultation** — the Executor deliberately calls a zero-argument `advisor()` tool.
2. **Automatic consultation** — an experimental routing layer evaluates materially new primary model-dispatch states and may synchronously consult the same Advisor before the Executor request proceeds.

Both paths converge on one fresh, stateless Advisor service. The Executor must not be required to summarize its own context or formulate a question for the Advisor.

## Product invariants

- OpenCode V2 only.
- Use current supported V2 Promise APIs; do not bypass the public plugin API for hidden transcript/session mutation.
- The explicit `advisor()` tool has no user arguments.
- Explicit and automatic consultations use the same Advisor service.
- Advisor inference is fresh/stateless; no private persistent Advisor conversation.
- Automatic routing occurs at safe pre-provider `session.context` boundaries, not by interrupting generation.
- Automatic advice is supplied with system authority; never fabricate an Executor tool call and never inject it as synthetic user input.
- Automatic-routing infrastructure fails open.
- Explicit consultation failures are visible to the Executor.
- Automatic routing remains experimental in v1.
- Direct TypeSafe integration is deferred from v1; v1 automatic routing uses OpenCode Zen only.

## Advisor context

The Advisor context is derived from the actual Executor working context, preserving role and chronological order.

The canonical serializer must represent, as applicable:

- system instructions;
- user text;
- assistant text;
- reasoning text that OpenCode exposes to the plugin;
- tool calls and arguments;
- tool results;
- compaction/checkpoint information where relevant;
- effort/state markers needed to understand the request;
- media/file presence and metadata.

### Media and unsupported content

OpenCode messages can contain media assets such as images, audio, video, and documents. The v1 Advisor path and Jev routing state are text/JSON-oriented, so the plugin must not claim semantic access to unsupported media.

Unsupported media must be represented explicitly rather than silently omitted or base64-dumped into prompts. A serialized representation should retain useful metadata such as:

- kind;
- MIME type;
- filename when available;
- dimensions/duration when available;
- source/reference kind where safe;
- an explicit marker that the Advisor did not directly inspect the media contents.

Text elsewhere in the conversation that describes the media remains normal context.

## Advisor model

The Advisor uses a configured model when one is provided.

If `advisor.model` is omitted, the default is to **inherit the current Executor model** for that consultation. The consultation remains fresh/stateless even when it uses the same model.

v1 uses one Advisor model at a time. No Advisor-model fallback chain is required in v1.

## Configuration

Auto Advisor owns an optional sparse global configuration file resolved according to OpenCode's global config-directory conventions.

Conceptual path on Unix-like systems:

```text
~/.config/opencode/auto-advisor.json
```

The implementation must resolve the platform-appropriate OpenCode config directory rather than hard-coding that literal path on every OS.

### Semantics

- no file -> all defaults;
- file exists and a key is omitted -> default for that key;
- valid explicit value -> explicit value wins;
- invalid explicit value -> clear configuration error; do not silently substitute a default.

v1 uses strict JSON and global-only configuration. No project-level Auto Advisor config or config-merging hierarchy is required.

Secrets do not belong in `auto-advisor.json`.

### User-facing knobs

v1 intentionally exposes six meaningful settings:

```json
{
  "advisor": {
    "model": "inherit"
  },
  "routing": {
    "mode": "off",
    "models": [
      "jev-1.13-free",
      "jev-1.13"
    ],
    "advisorWouldHelpThreshold": "<conservative default>",
    "consequenceThreshold": "<conservative default>",
    "maxConsultationsPerTurn": 1
  }
}
```

The six knobs are:

1. `advisor.model`
2. `routing.mode` — `off | observe | active`
3. `routing.models` — ordered Zen System One model fallback chain
4. `routing.advisorWouldHelpThreshold`
5. `routing.consequenceThreshold`
6. `routing.maxConsultationsPerTurn`

Internal behavior such as fingerprint implementation, telemetry schema, advice lifetime, retry timing, and serialization rules is not user-configurable in v1 unless implementation evidence shows a need.

## Routing modes

### `off`

Default mode.

- no Jev/System One evaluation;
- no automatic Advisor invocation;
- explicit `advisor()` remains available.

### `observe`

- evaluate routing opportunities;
- apply deterministic routing policy hypothetically;
- persist compact telemetry;
- do not invoke the Advisor automatically;
- do not modify Executor context.

Durable telemetry is mandatory for `observe`.

### `active`

- evaluate routing opportunities;
- apply deterministic routing policy;
- synchronously consult the Advisor when policy accepts and budget allows;
- inject resulting advice into the waiting Executor request with system authority.

## Routing opportunities

The routing boundary is a primary `session.context` dispatch.

A primary dispatch is not synonymous with a new user message: tool-driven continuations can produce additional primary dispatches during the same user turn.

The router evaluates a dispatch only when its normalized routing-relevant state fingerprint is materially new. Equivalent/unchanged states are suppressed. Plugin-injected automatic advice must not itself make the state appear newly routable.

A materially new tool result may therefore create a new routing opportunity within the same user turn.

## AdvisorRouter boundary

Stable plugin code depends on an `AdvisorRouter` abstraction rather than directly on OpenCode's experimental Evaluation/System One types.

Conceptually:

```ts
interface AdvisorRouter {
  evaluate(
    state: AdvisorRoutingState,
    signal?: AbortSignal
  ): Promise<RouterAssessment>
}

interface RouterAssessment {
  advisorWouldHelp: number
  consequence: number
  metadata?: Record<string, unknown>
}
```

Exact names may be refined during implementation planning.

OpenCode Evaluation types, System One wire details, provider metadata, and Jev-specific response shapes remain inside the adapter.

## Jev / System One

v1 uses OpenCode's `@opencode/ai` Evaluation/System One implementation behind `AdvisorRouter`.

Do not duplicate the System One wire protocol in stable plugin code. OpenCode's layer is responsible for normalizing Evaluation questions/responses, including mapping normalized boolean questions to System One's provider-native representation.

### v1 provider

Automatic routing uses **OpenCode Zen only**.

Direct TypeSafe support is deferred. If added later, prefer supported OpenCode integration/credential facilities or an environment-based secret such as `TYPESAFE_API_KEY`; never require raw TypeSafe credentials in `auto-advisor.json`.

### Routing questions

Use two independent atomic Evaluation questions over the same routing state:

1. **advisor_would_help** — normalized boolean probability: would independent expert review at this point materially improve correctness or catch an important issue in the primary agent's next action?
2. **consequence** — score on a fixed **0-4** rubric: how consequential would an incorrect next action be if the Executor proceeds without independent review?

The consequence rubric must have explicit semantic anchors from none/minimal through critical.

### Deterministic policy

The model estimates; plugin code decides.

Initial v1 policy:

```text
consult =
  advisor_would_help >= advisorWouldHelpThreshold
  AND
  consequence >= consequenceThreshold
```

Initial threshold values are conservative calibration defaults selected during implementation planning and validated through `observe`. They are configurable.

## Zen model fallback

`routing.models` is an ordered System One chain. The default is:

```json
["jev-1.13-free", "jev-1.13"]
```

Each new routing opportunity starts from the top of the configured chain. The plugin intentionally retries the free model first even if it failed for quota reasons recently, so recovered free capacity is used immediately and paid routing is not unnecessarily sticky.

### Retry vs fallback

A small bounded internal retry/backoff handles transient transport/provider failures such as short network failures or recoverable 5xx responses.

Fallback to the next configured model is appropriate for errors such as:

- quota exhaustion;
- rate limiting when retry is not appropriate/exhausted;
- model unavailable;
- provider/model capacity exhaustion.

Do not treat the following as model-fallback conditions:

- authentication failures;
- invalid configuration;
- malformed requests;
- schema/programming errors.

If the entire chain fails, automatic routing fails open **for that opportunity only**. Auto Advisor is not disabled globally. The next materially new routing opportunity starts again from the first configured model.

Retry/backoff tuning is internal in v1 rather than another user-facing knob.

## Automatic consultation budget

Automatic consultation budgeting is configurable.

Default:

```text
routing.maxConsultationsPerTurn = 1
```

It is a positive integer.

Only successful/attempted automatic consultations as defined by the implementation contract consume the automatic budget; explicit `advisor()` calls do not consume it.

The implementation planner must define exact accounting around Advisor failures so behavior is deterministic and testable.

Once the per-turn budget is exhausted, further routing opportunities may be suppressed from automatic consultation for that turn according to mode semantics, while explicit `advisor()` remains available.

## Automatic advice lifetime

Automatic advice is plugin-owned state associated with the session and originating user-turn identity.

For v1:

1. successful automatic advice is injected as system-role context through `session.context`;
2. the applicable advice is reinjected on relevant continuations within that same user turn;
3. a newer automatic review supersedes an older active review;
4. normal new user input expires prior active advice;
5. advice does not grow unbounded across later turns.

Do not use `session.synthetic` and do not fabricate an Executor `advisor()` call.

## Reentrancy

Auxiliary Jev/System One evaluation and Advisor inference must not recursively create additional routing opportunities for themselves.

The implementation must prove this with focused tests/runtime validation.

## Failure behavior

### Automatic path

Fail open. Routing, provider, Advisor, advice-delivery, and telemetry failures must not unnecessarily block normal Executor continuation.

Failures remain observable through diagnostics/telemetry where possible.

### Explicit path

A deliberate `advisor()` failure must be visible as the tool result/error.

## Telemetry

Telemetry is disabled by default. `observe` requires durable telemetry.

Use OpenCode plugin-owned storage (`ctx.storage`) for compact structured events rather than copying full conversation transcripts by default.

Useful event fields include:

- event/opportunity identifier;
- session/turn-safe identity fields;
- routing-state fingerprint;
- router model actually used;
- normalized router answers;
- deterministic policy outcome;
- mode;
- consultation identifier when applicable;
- Advisor model when applicable;
- latency/usage/cost metadata when available;
- classified error/fallback/retry information;
- later validation signals when reasonably attributable.

Never store credentials/secrets.

Retention should be bounded internally with a generous fixed cap in v1 rather than adding another user knob.

Expose read-only plugin RPC(s) for telemetry scan/export so evaluation tooling can retrieve records without depending on OpenCode's physical storage implementation. JSONL export is an appropriate offline-evaluation format.

## Package/release expectations

- Package is V2-only.
- Initial dependency compatibility is deliberately based on OpenCode 2.0.18.
- Publish on npm `latest`.
- Current repository release tooling already supports V2 packages on `latest`; no redesign based on the obsolete `opencode2` assumption is required.
- Register the new package in existing release policy/guard data and tests as needed.
- Add a Changeset only when the package becomes releasable.
- Run repository quality gates and real package-root OpenCode runtime smoke validation before release.

## Non-goals for v1

- OpenCode V1 support;
- direct TypeSafe routing provider;
- OpenRouter or arbitrary System One providers;
- automatic discovery/switching to newly published System One models;
- persistent private Advisor conversation state;
- Advisor tools or independent repository investigation;
- multimodal semantic inspection by the Advisor;
- mid-generation watchdog/interruption;
- fabricated tool calls;
- synthetic user-role advice;
- adaptive/learned routing thresholds;
- project-level Auto Advisor config;
- Advisor-model fallback chain;
- elaborate cooldown/circuit-breaker machinery.

## Execution structure

Tracking epic: #47

Execution contracts:

- **#48 — Core Advisor and routing foundation**
  - package/config;
  - explicit `advisor()`;
  - context capture/serialization;
  - AdvisorService;
  - routing domain/modes;
  - fingerprinting;
  - deterministic policy;
  - automatic budget.

- **#50 — Experimental Zen automatic routing and delivery**
  - OpenCode Evaluation/System One adapter;
  - ordered Zen model fallback;
  - observe telemetry/storage/RPC;
  - active automatic consultation;
  - system-context delivery/lifetime;
  - failure/retry/fallback behavior;
  - reentrancy;
  - runtime validation.

Release/docs/final-readiness work is tracked by the epic acceptance checklist rather than a separate release issue.

## Implementation authorization

Implementation is **approved as of 2026-09-28**. The coding orchestrator may proceed with implementation against this governing plan and the active issue contracts.

During implementation, the coding orchestrator must:

1. inspect current repository instructions and current OpenCode V2 source/docs before relying on runtime/API assumptions;
2. inspect this plan and the active issue contracts;
3. use the agents/tools available in its execution environment appropriately;
4. refine implementation details and the validation graph as concrete code/runtime evidence requires;
5. select and document conservative initial threshold defaults and the 0-4 consequence anchors;
6. resolve implementation details such as exact state fingerprint construction and deterministic budget accounting on failures;
7. keep this plan and the active issue contracts synchronized with material findings.

No additional approval pause is required for implementation that stays within this approved scope.

Material changes to requirements, architecture, public interfaces, privacy/security behavior, configuration semantics, release strategy, or acceptance criteria require the durable plan to be updated and explicitly re-approved before those changes are implemented.
