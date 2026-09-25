# ADR-0002: Treat automatic routing as experimental in v1

## Status

Accepted

## Context

OpenCode V2 provides a synchronous `session.context` hook immediately before provider dispatch, which is a suitable safe boundary for automatic routing.

The initial routing implementation uses OpenCode's Evaluation/Jev capability. That API is published under an experimental surface whose contract is explicitly expected to evolve. Independently of API stability, the project does not yet have empirical evidence that Jev's routing precision justifies the latency and cost of evaluating materially new Executor dispatches.

The plugin needs the automatic-routing architecture in v1 without presenting an unvalidated router as stable/default behavior.

## Decision

v1 includes automatic routing behind three modes:

- `off` — no automatic routing; explicit `advisor()` remains available.
- `observe` — Jev evaluates routing opportunities and records the assessment and hypothetical deterministic policy result, but does not invoke the Advisor or alter Executor context.
- `active` — Jev evaluates routing opportunities and deterministic policy may trigger an automatic Advisor consultation.

`off` is the default.

Telemetry is required in `observe`.

Automatic routing remains documented as experimental in v1.

The stable domain depends on an `AdvisorRouter` abstraction and a normalized router assessment. OpenCode Evaluation types, System One types, confidence metadata, and provider-specific structures remain inside the Jev adapter.

v1 Jev provider scope is limited to:

- direct TypeSafe AI;
- OpenCode Zen.

Automatic consultation budgeting is configurable, initially defaulting to one automatic consultation per user turn.

## Alternatives considered

### Enable automatic routing by default

Rejected because both the Evaluation API contract and routing quality are insufficiently validated.

### Ship explicit Advisor first and add routing in a later product version

Rejected because independent routing is a core product requirement and the surrounding architecture can be established safely now. The implementation may sequence explicit foundations before routing, but v1's product architecture contains both paths.

### Build deterministic pre-routing heuristics instead of Jev

Rejected as the primary approach because it would duplicate the judgment the routing model is intended to provide and introduce premature policy complexity. Deterministic policy still governs whether a model estimate causes a consultation.

### Couple stable interfaces directly to OpenCode Evaluation types

Rejected because the Evaluation contract is experimental and likely to change.

## Consequences

- v1 can collect routing evidence without changing Executor behavior.
- Jev can be replaced later without rewriting the Advisor service.
- Provider/API churn is concentrated in one adapter boundary.
- `observe` introduces a clear calibration path before stronger stability claims.
- Automatic routing still incurs extra inference latency/cost in `observe` and `active`.
- The supported OpenCode/Evaluation range must be explicitly tested and revalidated.

## Supersedes

None.

## Superseded by

None.
