# OpenCode V2 Jev / Evaluation research

**Status:** current; revalidate before implementation  
**Last verified:** 2026-09-25  
**Scope:** OpenCode V2 experimental Evaluation/Jev capability as the initial automatic-consultation router.

## Question

Is OpenCode's Evaluation/Jev capability suitable as the first `AdvisorRouter`, and what stability/provider constraints should v1 adopt?

## Sources

### Upstream

- OpenCode V2 repository: https://github.com/anomalyco/opencode/tree/v2
- `@opencode/ai` README: https://github.com/anomalyco/opencode/blob/v2/packages/ai/README.md
- Experimental Evaluation implementation: https://github.com/anomalyco/opencode/blob/v2/packages/ai/src/experimental/evaluation.ts
- `@opencode/ai` package manifest: https://github.com/anomalyco/opencode/blob/v2/packages/ai/package.json
- `@opencode/plugin` package manifest: https://github.com/anomalyco/opencode/blob/v2/packages/plugin/package.json

### Related project research

These documents in `capyBearista/opencode-config` were reviewed as additional context:

- https://github.com/capyBearista/opencode-config/blob/main/docs/V2-2026.09.24-configuration-research.md
- https://github.com/capyBearista/opencode-config/blob/main/docs/V2-2026.09.24-release-notes-and-capabilities.md

## Findings

### Evaluation is intentionally experimental

The Evaluation contract is isolated under `@opencode/ai/experimental`, and upstream describes that isolation as intentional while the contract evolves.

This is the primary stability reason automatic Jev routing should not be presented as stable/default in v1.

### Evaluation is a natural fit for a routing adapter

The project needs a small normalized decision surface such as:

- consultation probability;
- consequence;
- reason/category.

Evaluation-style boolean/score/choice judgments map naturally into that shape.

The stable plugin architecture should not expose OpenCode Evaluation types directly. The adapter translates experimental/provider-specific output into the project's own `RouterAssessment`.

### API stability is not the only unknown

Even if the Evaluation API stopped changing, the project still needs evidence that Jev's routing quality justifies an extra inference before materially new Executor dispatches.

That product-quality uncertainty motivates `observe` mode.

### Observe mode enables counterfactual routing evaluation

In `observe`:

1. a routing opportunity is identified;
2. Jev evaluates it;
3. deterministic policy computes what it would have done;
4. telemetry records the result;
5. the Advisor is not invoked;
6. Executor context is not changed.

This produces evidence about routing behavior without changing task trajectories.

### Provider scope should stay narrow in v1

v1 supports:

- direct TypeSafe AI;
- OpenCode Zen.

OpenRouter and other possible routes are excluded from v1 to keep the experimental authentication/provider surface bounded.

### Provider-specific behavior belongs inside the adapter

The stable routing layer should not depend on:

- raw Evaluation result types;
- System One model types;
- raw provider confidence metadata;
- provider-specific option structures;
- Evaluation API naming that may change.

Only normalized project-domain assessment leaves the adapter.

### Compatibility needs an explicitly tested OpenCode range

Because Evaluation and the V2 plugin system are evolving together, v1 should declare a tested compatible OpenCode V2 range rather than imply arbitrary V2 support.

The exact range and dependency syntax are implementation-plan decisions that must be based on the versions actually exercised.

## Project conclusions

Automatic routing v1 uses the following posture:

```text
routing.mode = off | observe | active

default = off

off:
  no Jev evaluation

observe:
  Jev evaluation
  deterministic hypothetical policy
  required durable telemetry
  no Advisor call
  no Executor-context mutation

active:
  Jev evaluation
  deterministic policy
  optional automatic Advisor consultation
```

Automatic routing remains experimental.

The architecture should make future replacement with Laya or another classifier possible without changing AdvisorService.

## Telemetry implications

At minimum, observation data should retain enough normalized information to reconstruct:

- opportunity/state fingerprint;
- normalized routing state;
- provider/router identity;
- assessment;
- deterministic policy result;
- consultation ID if active;
- later validation/failure signals where reasonably attributable.

Full conversations and credentials should not be copied to telemetry by default.

## Limitations

- Evaluation API names, shapes, provider options, and metadata may change.
- Routing-quality conclusions cannot be drawn from API design alone.
- This document must be revalidated against the exact OpenCode version selected by the implementation orchestrator before Jev code is written.

## Related decisions and plan

- [ADR-0002](../decisions/0002-experimental-automatic-routing.md)
- [Auto Advisor plan](../plans/opencode-auto-advisor.md)
