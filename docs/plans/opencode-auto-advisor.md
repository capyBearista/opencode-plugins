# OpenCode Auto Advisor

**Status:** Draft  
**Tracking issue:** [#47](https://github.com/capyBearista/opencode-plugins/issues/47)  
**Package:** `@capybearista/opencode-auto-advisor`

## Goal

Create an OpenCode V2 server plugin that provides a Claude Code-style independent Advisor through two consultation paths:

1. **Explicit consultation** — the Executor deliberately calls zero-argument `advisor()`.
2. **Automatic consultation** — an experimental routing layer evaluates the Executor state at safe primary model-dispatch boundaries and may consult the same Advisor before the next Executor inference proceeds.

Both paths use the same fresh, stateless Advisor behavior and the same evidence model.

## Problem

Explicit Advisor tools are valuable but inherit a self-routing weakness: the Executor must recognize that consultation is warranted.

A continuous autonomous watchdog could remove that dependency, but it introduces persistent reviewer state, asynchronous races, duplicated investigation, stale advice, interruption semantics, and substantially more lifecycle complexity than required.

Auto Advisor therefore combines Executor self-awareness with independent between-inference routing.

## Requirements

### Explicit Advisor

Expose:

```text
advisor()
```

The tool accepts no arguments.

Calling it must:

- pause normal Executor continuation like an ordinary tool call;
- obtain the actual relevant Executor context through the consultation point;
- invoke a freshly configured Advisor model;
- return concise plain-text advice as the genuine tool result;
- allow the Executor to continue with that result in normal conversation history.

The Executor must not be required to summarize its context or formulate a question for the Advisor.

### Advisor context

The plugin owns evidence collection.

Advisor context must be derived from the actual Executor working context rather than an Executor-authored summary.

The canonical representation should preserve, where available:

- system instructions;
- user and assistant messages;
- textual reasoning;
- tool calls;
- tool results;
- the current assistant state through the consultation point;
- useful file/media metadata when direct multimodal replay is unavailable.

Because the current public fresh-generation primitive accepts a text prompt rather than arbitrary parent `system/messages` arrays, the context must be represented through a faithful canonical textual envelope.

The plugin must not claim that the Advisor directly consumed media content when only metadata or textual representations were supplied.

### Advisor behavior

Every consultation is fresh and stateless.

The Advisor:

- uses the configured model;
- has no persistent private conversation;
- receives no independent repository or network tools in v1;
- performs broad independent situational judgment rather than acting as a narrow code-review specialist;
- returns plain text rather than a required structured schema.

A user must configure an Advisor model. The plugin does not characterize the configured model as objectively stronger.

### Shared Advisor service

Explicit and automatic consultation converge on one conceptual Advisor service:

```text
                         ┌──────────────┐
explicit advisor() ─────►│              │
                         │ Advisor      │
automatic route ────────►│ Service      │
                         │              │
                         └──────┬───────┘
                                │
                     fresh configured inference
                                │
                                ▼
                            Executor
```

The Advisor service must not depend on Jev or automatic-routing policy.

### Automatic routing boundary

Automatic routing does not interrupt an Executor in the middle of model generation.

It operates synchronously at a safe primary model-dispatch boundary:

```text
OpenCode prepares next Executor request
                ↓
          session.context
                ↓
        routing opportunity
                ↓
              Jev
                ↓
      deterministic policy
          /           \
        skip          consult
                        ↓
                    Advisor
                        ↓
              inject advice
                        ↓
             Executor request
```

The hook itself provides the pause. `session.interrupt()` is not the normal routing mechanism.

### Automatic-routing modes

Configuration exposes:

```text
off
observe
active
```

#### `off`

- no Jev evaluation occurs;
- explicit `advisor()` remains available.

This is the default.

#### `observe`

- routing opportunities are evaluated;
- Jev assessments and hypothetical deterministic policy decisions are recorded;
- the Advisor is not invoked automatically;
- Executor context is not changed.

Durable telemetry is required in this mode.

#### `active`

- routing opportunities are evaluated;
- deterministic policy may trigger an Advisor consultation;
- resulting advice is supplied before the waiting Executor request proceeds.

Automatic routing remains experimental in v1.

### Routing opportunities

The initial design evaluates materially new primary Executor dispatch states rather than introducing an elaborate deterministic pre-router heuristic system.

Duplicate/equivalent routing states are suppressed using an appropriate state/context fingerprint.

The implementation planner may refine the exact definition of “materially new,” but must avoid repeatedly evaluating unchanged state.

### Router boundary

The stable plugin domain depends on an Advisor-router abstraction rather than OpenCode's experimental Evaluation types.

Conceptually:

```ts
interface AdvisorRouter {
  evaluate(
    state: AdvisorRoutingState,
    signal?: AbortSignal
  ): Promise<RouterAssessment>
}

interface RouterAssessment {
  consultationProbability: number
  consequence: number
  reason: ConsultationReason | "none"
  metadata?: Record<string, unknown>
}
```

Exact internal naming may be refined during implementation planning.

OpenCode Evaluation types, System One types, raw confidence structures, provider metadata, and other Jev-specific details remain inside the Jev adapter.

### Jev support

v1 supports Jev through:

- direct TypeSafe AI;
- OpenCode Zen.

OpenRouter or other Jev routes are outside v1.

Jev integration is experimental because the OpenCode Evaluation API is explicitly evolving.

The implementation must declare and test a specific compatible OpenCode V2 range rather than assuming arbitrary V2 compatibility.

### Routing policy

Router estimates and application decisions are separate concerns.

The routing model estimates whether consultation appears warranted. A deterministic policy decides whether the plugin actually consults.

Thresholds are configurable. Initial exact threshold values are implementation/calibration details.

### Automatic consultation budget

Automatic consultation limits are configurable.

The initial default is:

```text
1 automatic consultation per user turn
```

Explicit consultations do not consume this automatic budget.

No elaborate cooldown/backlog machinery is required unless evidence later demonstrates a need.

### Explicit advice delivery

Explicit consultation uses the genuine OpenCode tool-call/tool-result flow.

Its result persists according to normal session-history behavior.

### Automatic advice delivery

Automatic advice must not fabricate an Executor `advisor()` call.

It must not use `session.synthetic`, because V2 lowers synthetic input to the model as user-role content.

For v1:

1. automatic advice is injected as system-role context through `session.context`;
2. the applicable review is retained in plugin-owned state;
3. the same review is reinjected on relevant continuations during the same user turn;
4. a newer review supersedes an older active review;
5. normal new user input expires the prior active review.

OpenCode has native durable session instruction-entry machinery with more appropriate long-term semantics, but that API is currently not exposed through the supported Promise or Effect plugin context.

v1 must not bypass the supported plugin API merely to gain native instruction persistence.

The design should allow a later delivery implementation to use native durable instruction entries if OpenCode exposes them to plugins.

### Failure behavior

Automatic-routing infrastructure fails open.

Failures in opportunity evaluation, Jev/provider access, policy plumbing, automatic Advisor invocation, or automatic advice delivery must not unnecessarily prevent Executor continuation.

Failures must remain observable through appropriate diagnostics/telemetry.

An explicit `advisor()` failure is different: because the Executor deliberately requested consultation, the tool result/error must make the failure visible to it.

### Telemetry

Telemetry is disabled by default.

`observe` requires durable telemetry because observation without retained evaluation data defeats the mode's purpose.

Telemetry should retain enough normalized information to evaluate routing quality and compare future routers without copying the full conversation by default.

Relevant data includes conceptually:

- routing opportunity;
- normalized routing state;
- state/context fingerprint;
- router/provider;
- router assessment;
- deterministic policy decision;
- trigger type;
- consultation identifier when applicable;
- Advisor model when applicable;
- operational latency/cost when available;
- later validation/failure signals when reasonably attributable.

The exact durable schema/path is an implementation-planning detail.

Secrets and credentials must never be written to telemetry.

### Configuration

Use OpenCode V2 native plugin configuration through `plugins[].options`.

Do not introduce a plugin-specific sidecar configuration file.

Credentials should use supported environment/file substitution or provider authentication rather than committed secrets.

## Non-goals

v1 does not aim to provide:

- OpenCode V1 support;
- a continuous OMP-style watchdog;
- token-by-token or mid-generation interruption;
- persistent private Advisor conversation state;
- independent Advisor repository investigation;
- Advisor tools;
- Laya or a custom-trained routing model;
- OpenRouter Jev support;
- automatic routing enabled by default;
- provider-native parent transcript replay when the public generation API cannot provide it;
- fake tool calls for automatically generated advice;
- user-role synthetic messages for Advisor guidance;
- reliance on currently unexposed OpenCode instruction-entry APIs;
- full-transcript telemetry by default;
- replacement of `opencode-adversarial-review`.

## Facts and constraints

- `session.context` is the supported safe pre-provider mutation boundary for automatic routing.
- Current fresh selected-model generation accepts a textual prompt, requiring faithful context serialization.
- OpenCode Evaluation/Jev is experimental.
- Native session instruction entries exist but are not exposed through the current plugin context.
- `session.synthetic` is model-visible as user-role input and is therefore unsuitable for Advisor guidance.
- Automatic routing adds inference latency/cost and must be measured before stronger stability claims.
- The package is OpenCode V2-only and has no V1 line.
- npm distribution channel is **`latest`**, not `opencode` or `opencode2`.
- The monorepo release guard currently couples V2 release classification to the existing `opencode2` flow and must be generalized safely before release.

## Assumptions requiring implementation validation

### Explicit-call context fidelity

Verify that all material assistant text/reasoning immediately preceding `advisor()` can be reconstructed when the tool executes.

The focused runtime test must:

1. make the Executor emit meaningful text/reasoning;
2. make it call `advisor()`;
3. inspect the captured Advisor context;
4. assert that the immediately preceding material is recoverable.

Do not add streaming-delta capture unless this demonstrates a real gap.

### Jev routing quality

The usefulness of Jev as an intervention router is not established empirically.

`observe` exists to gather evidence without changing Executor behavior.

### Provider compatibility

Direct TypeSafe AI and OpenCode Zen behavior must be tested against the supported OpenCode V2 range.

### Session/turn state

Plugin-owned active advice and consultation budgeting must be reliably associated with the correct session and user turn.

## Relevant research

- [Claude Code Advisor research](../research/claude-code-advisor.md)
- [OpenCode V2 Advisor runtime research](../research/opencode-v2-advisor-runtime.md)
- [OpenCode V2 Jev / Evaluation research](../research/opencode-v2-jev-evaluation.md)

## Relevant decisions

- [ADR-0001 — Dual-path Auto Advisor architecture](../decisions/0001-dual-path-auto-advisor.md)
- [ADR-0002 — Experimental automatic routing](../decisions/0002-experimental-automatic-routing.md)
- [ADR-0003 — Automatic advice delivery](../decisions/0003-automatic-advice-delivery.md)
- [Decision ledger](../DECISIONS.md)

## Existing-system context

The package belongs in the existing Bun/Turborepo monorepo and follows established V2 server-plugin conventions:

- TypeScript strict mode;
- `@opencode/plugin` Promise API;
- `Plugin.define({ id, setup })`;
- package-root `server.js`;
- colocated package tests;
- package-specific `AGENTS.md`;
- MPL-2.0;
- Changesets for releasable changes;
- canonical root build/typecheck/lint/test validation;
- runtime smoke verification against the actual OpenCode loading path.

Auto Advisor is intentionally distinct from `opencode-adversarial-review`:

```text
Adversarial Review
fresh reviewer
intentionally clean context
independent repository investigation
adversarial code-review objective

Auto Advisor
fresh reviewer
actual parent execution context
no independent tools in v1
broad trajectory/judgment objective
```

## Blocking prerequisites

There is no unresolved product-level prerequisite preventing implementation planning.

Before release, implementation must resolve and verify:

- exact supported OpenCode V2 version/range;
- explicit-call context-fidelity runtime behavior;
- TypeSafe AI and Zen Evaluation compatibility;
- actual package-root server-plugin loading;
- safe release-policy support for a V2-born package published on `latest`.

A validation failure that materially changes architecture, requirements, public interfaces, security/privacy behavior, or release strategy returns this plan to `Awaiting implementation approval`.

## Proposed design

### Explicit path

```text
Executor
    ↓
advisor()
    ↓
capture actual Executor context
    ↓
AdvisorService
    ↓
fresh configured model
    ↓
plain-text advice
    ↓
real tool result
    ↓
Executor continues
```

### Automatic path

```text
primary Executor dispatch
          ↓
    session.context
          ↓
 materially new state?
      /          \
    no            yes
    │              ↓
 continue      build routing state
                   ↓
             AdvisorRouter
                   ↓
                Jev
                   ↓
            RoutingPolicy
              /       \
            skip     consult
             │          ↓
             │     AdvisorService
             │          ↓
             │    active advice state
             │          ↓
             └──► system-role injection
                        ↓
                 Executor request
```

In `observe`, the consult branch is recorded as a hypothetical policy outcome but does not invoke the Advisor or modify Executor context.

## Work decomposition

The execution contracts are:

1. [#48 — Establish V2 package and explicit Advisor path](https://github.com/capyBearista/opencode-plugins/issues/48)
2. [#49 — Establish routing domain and mode control](https://github.com/capyBearista/opencode-plugins/issues/49)
3. [#50 — Add Jev adapters and observe-mode telemetry](https://github.com/capyBearista/opencode-plugins/issues/50)
4. [#51 — Add active automatic consultation and system-context delivery](https://github.com/capyBearista/opencode-plugins/issues/51)
5. [#52 — Integrate release policy, documentation, and v1 readiness validation](https://github.com/capyBearista/opencode-plugins/issues/52)

These are execution outcomes, not the final coding task graph. The coding orchestrator refines the implementation work graph after inspecting the current repository and capabilities available in its environment.

## Validation strategy

### Pure/domain validation

Test:

- configuration validation;
- routing-mode behavior;
- routing-policy decisions;
- budget accounting;
- fingerprint/deduplication;
- active-advice expiry/supersession;
- telemetry serialization;
- provider-adapter normalization;
- fail-open automatic behavior.

### Explicit Advisor integration

Verify:

- `advisor()` has an empty input schema;
- the Executor-visible description communicates intended use;
- the configured Advisor model is used;
- actual parent context is represented faithfully;
- the tool returns plain-text advice;
- consultation failures are visible;
- preceding same-turn text/reasoning is captured.

### Automatic-routing integration

Verify:

- Jev only runs at intended primary dispatch boundaries;
- `off` performs no automatic routing;
- `observe` cannot invoke Advisor or mutate Executor context;
- `observe` requires telemetry;
- `active` synchronously gates the waiting dispatch;
- automatic failures allow Executor continuation;
- automatic advice has system authority;
- automatic advice is not represented as user input or a fake tool result;
- applicable advice survives continuations in the same turn;
- new user input expires prior active advice;
- automatic budget is enforced;
- auxiliary inference does not recursively trigger routing.

### Provider validation

Exercise:

- direct TypeSafe AI;
- OpenCode Zen.

### Runtime validation

Use a real supported OpenCode V2 installation and package-root server entrypoint.

At minimum exercise:

- explicit consultation;
- `off`;
- `observe`;
- `active`;
- a tool-result continuation;
- a failing automatic-router/Advisor scenario;
- configuration/authentication errors.

### Release validation

The release guard must recognize a V2-born package on npm `latest` without weakening existing frozen V1/V2 guarantees or allowing unsafe mixed V1/V2 batches.

## Documentation impact

Implementation is expected eventually to require:

- package README;
- package `AGENTS.md`;
- root plugin/compatibility documentation;
- V1/V2 compatibility documentation;
- release-policy documentation;
- root PR plugin checklist updates.

Do not describe Auto Advisor as current repository architecture before it exists.

## Acceptance criteria for v1

v1 is ready when:

- the V2 package loads through its real server entrypoint;
- a configured zero-argument `advisor()` provides a fresh transcript-aware consultation;
- explicit context fidelity is runtime verified;
- `off`, `observe`, and `active` behave distinctly and correctly;
- direct TypeSafe AI and Zen routing work against the declared supported V2 range;
- `observe` produces usable telemetry without changing Executor behavior;
- `active` can synchronously consult and inject system-role advice;
- automatic failures fail open;
- active automatic advice has bounded, correct turn lifetime;
- repository quality gates and runtime smoke validation pass;
- release tooling safely supports the V2-born `latest` policy;
- user-facing docs accurately mark automatic routing as experimental.

## Implementation handoff

Before modifying implementation code, the coding orchestrator must:

1. inspect repository instructions, this plan, relevant decisions, research, issues, current OpenCode APIs, and affected release tooling;
2. inspect the agents, skills, tools, and capabilities actually available in its environment;
3. refine the implementation work graph and validation strategy;
4. resolve implementation-level open questions such as supported OpenCode versions and dependency pins;
5. update this durable plan with material implementation-specific detail rather than leaving it only in chat history;
6. set this plan to **Awaiting implementation approval**;
7. present the refined plan to the user;
8. stop before implementation.

Implementation begins only after explicit user approval.

If implementation discovery materially changes requirements, scope, architecture, accepted decisions, public interfaces, security/privacy behavior, release strategy, or acceptance criteria, update the durable artifacts, return the plan to `Awaiting implementation approval`, and request approval again.
