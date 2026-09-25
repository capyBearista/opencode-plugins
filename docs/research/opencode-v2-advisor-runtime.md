# OpenCode V2 Advisor runtime research

**Status:** current  
**Last verified:** 2026-09-25  
**Scope:** OpenCode V2 plugin/runtime capabilities needed for explicit and automatic Advisor consultation.

## Question

Can a V2 plugin capture the necessary Executor context, invoke a fresh Advisor model, gate automatic consultation at a safe boundary, and deliver advice with correct model-role semantics?

## Primary sources

- OpenCode V2 repository, `v2` branch: https://github.com/anomalyco/opencode/tree/v2
- Promise session API: https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/session.ts
- Promise plugin adapter: https://github.com/anomalyco/opencode/blob/v2/packages/plugin/src/promise/adapter.ts
- Session request/context construction: https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/context.ts
- Model-message lowering: https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/runner/to-llm-message.ts
- Session message schema: https://github.com/anomalyco/opencode/blob/v2/packages/schema/src/session-message.ts
- Session protocol group: https://github.com/anomalyco/opencode/blob/v2/packages/protocol/src/groups/session.ts
- Session history/compaction behavior: https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/history.ts

## Findings

### `session.context` is the correct synchronous automatic-routing boundary

The Promise V2 session API exposes a mutable context hook containing the outgoing model-facing state: session/model/agent information, system parts, messages, options, and tool definitions.

The hook runs as part of request preparation before provider dispatch.

Therefore automatic routing can synchronously gate the next Executor inference:

```text
prepare primary request
        ↓
session.context
        ↓
route / maybe consult
        ↓
provider dispatch
```

No token-stream watchdog or normal `session.interrupt()` flow is required.

### Automatic routing should occur between Executor inferences

A tool result naturally causes OpenCode to prepare another primary model request so the Executor can continue.

That continuation boundary is where the plugin evaluates the updated state. The design does not attempt to stop an Executor halfway through an active model generation.

### Promise tools have access to session/message identity

Tool execution context includes the session and assistant-message identity needed to associate explicit consultation with the parent turn.

Core session processing projects tool-call state before tool execution. This provides a practical route to recover the current assistant state around an explicit `advisor()` call.

One narrow runtime question remains implementation validation: whether every provider closes/persists meaningful text or reasoning immediately adjacent to a tool call before the local tool starts. The product plan therefore requires a focused runtime test before adding streaming-delta capture.

### `generate.text()` is a fresh selected-model primitive, but text-only

The V2 plugin generation surface can target a configured model without creating a normal Executor Session step.

It accepts a text prompt rather than arbitrary parent `system/messages` arrays.

Therefore Auto Advisor cannot currently replay the parent request as provider-native structured messages while independently selecting the Advisor model through this public primitive.

The v1 design serializes actual parent evidence into a canonical textual envelope. This preserves the important invariant that the Executor does not author the evidence summary.

### Auxiliary Advisor generation does not require Session recursion

The planned Advisor call uses the lower-level generation domain rather than `session.generate()`.

That avoids creating another agent-loop Session dispatch from inside the primary `session.context` hook and therefore avoids the obvious routing-hook recursion path.

Runtime validation should still assert that auxiliary Advisor/Evaluation calls do not trigger automatic routing unexpectedly.

### `session.synthetic` is durable but has the wrong model authority

V2 exposes `session.synthetic` to plugins.

However, `to-llm-message.ts` lowers a synthetic session message to a model message with the `user` role.

That makes it inappropriate for automatic Advisor guidance: the plugin must not make independent review text appear to be user-authored instruction.

### Native system/session instruction updates exist

V2 has session instruction-entry endpoints:

- list;
- put;
- remove.

The protocol describes them as durable instruction entries whose changes are announced at the next step boundary.

This is semantically close to the desired long-term automatic-advice behavior and underlies chronological instruction-update behavior visible in the TUI.

### Normal plugins cannot currently access instruction entries through `ctx.session`

The full client/protocol contains the instruction-entry API, but both Promise and Effect plugin `SessionDomain` types deliberately expose a narrower subset.

The Promise adapter also constructs `ctx.session` explicitly from that reduced set and omits instruction entries, confirming this is a runtime capability restriction rather than only missing TypeScript declarations.

Therefore v1 should not depend on native instruction entries or bypass the supported plugin API to reach them.

### `session.context` injection is request-local

Mutating the outgoing context provides correct system-role authority for the current provider request, but it is not itself a new durable session transcript entry.

v1 therefore needs plugin-owned active automatic-advice state and same-turn reinjection across relevant continuations.

The active review expires on normal new user input or is superseded by a newer review.

### Future native instruction persistence would complement, not necessarily replace, current-request injection

Instruction-entry updates are announced at a later step boundary. An automatic review generated while the current `session.context` hook is already preparing a request may still need direct context injection for that waiting request.

A future native implementation may combine:

- immediate system injection for the current request;
- durable instruction persistence for subsequent requests.

## Project conclusions

The supported v1 delivery architecture is:

```text
Explicit:
Executor → advisor() → fresh Advisor → genuine tool result

Automatic:
primary session.context
        → router
        → optional fresh Advisor
        → plugin-owned active review
        → system-role request injection
```

Do not use:

- `session.synthetic` for Advisor guidance;
- fabricated tool calls;
- currently unexposed session instruction-entry APIs.

## Required runtime validations

- explicit same-turn text/reasoning context fidelity;
- real package-root V2 plugin loading;
- no routing recursion from auxiliary inference;
- correct same-turn automatic-advice lifetime;
- fail-open automatic-routing behavior.

## Limitations

- V2 is moving quickly; source behavior must be revalidated against the exact supported release range selected during implementation planning.
- The public plugin API may expose durable instruction entries later, which should trigger reconsideration of ADR-0003 without changing the higher-level Advisor architecture.

## Related decisions and plan

- [ADR-0001](../decisions/0001-dual-path-auto-advisor.md)
- [ADR-0003](../decisions/0003-automatic-advice-delivery.md)
- [Auto Advisor plan](../plans/opencode-auto-advisor.md)
