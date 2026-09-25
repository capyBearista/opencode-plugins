# ADR-0001: Use a dual-path Auto Advisor architecture

## Status

Accepted

## Context

A Claude Code-style Advisor is useful when an Executor recognizes that it needs independent judgment. That explicit pattern has a self-routing weakness: the same Executor that is uncertain or mistaken must recognize that consultation is warranted.

A continuous parallel watchdog could independently intervene, but it adds persistent reviewer state, asynchronous races, duplicated investigation, stale advice, interruption semantics, and substantial orchestration complexity.

The project needs independent routing without turning the Advisor into a continuously running second agent.

## Decision

Auto Advisor uses two consultation paths that converge on one shared Advisor service:

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

The explicit path is triggered by the Executor calling zero-argument `advisor()`.

The automatic path evaluates the Executor state at safe primary model-dispatch boundaries and may consult the same Advisor before the next Executor inference proceeds.

The Advisor service:

- receives plugin-collected actual Executor context rather than an Executor-authored summary;
- uses a configured model;
- creates a fresh stateless inference for every consultation;
- has no persistent private Advisor conversation;
- has no independent tools in v1;
- returns concise plain-text judgment.

Automatic routing logic is kept outside the Advisor service.

## Alternatives considered

### Explicit-only Advisor

This reproduces the useful Claude Advisor mechanism but leaves consultation entirely dependent on Executor self-awareness.

Rejected as the complete product architecture because independent routing is a core project goal.

### Persistent autonomous watchdog

A background reviewer could observe the Executor continuously and push unsolicited guidance.

Rejected because it creates substantially more lifecycle, synchronization, stale-context, cost, and interruption complexity than required. The project intentionally routes between Executor inferences instead of supervising token streams continuously.

### Separate explicit and automatic Advisor implementations

Separate services could tailor behavior to each trigger.

Rejected because both paths are meant to request the same kind of independent judgment over the same evidence. Duplicating Advisor personalities or context logic would create drift.

## Consequences

- Explicit and automatic consultation share context capture and Advisor behavior.
- Automatic routing can evolve or be replaced without changing the Advisor.
- The design avoids mid-generation interruption.
- The Executor can still override Advisor guidance when evidence warrants it.
- Fresh consultations reduce anchoring from a persistent reviewer history.
- Context fidelity becomes a critical validation requirement.

## Supersedes

None.

## Superseded by

None.
