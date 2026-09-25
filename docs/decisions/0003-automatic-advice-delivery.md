# ADR-0003: Deliver automatic advice as plugin-managed system context in v1

## Status

Accepted

## Context

Explicit `advisor()` consultation naturally produces a genuine tool call and tool result that persist in normal conversation history.

Automatic routing is different: the Executor did not call `advisor()`. Fabricating a tool invocation would make the transcript claim an action the Executor never took.

OpenCode V2 exposes `session.synthetic` to plugins, but synthetic messages are lowered to user-role model messages. Advisor guidance should not impersonate the user.

OpenCode V2 also has durable session instruction-entry machinery that is semantically appropriate for privileged chronological updates, but the current Promise and Effect plugin contexts do not expose that API. Directly bypassing the supported plugin surface would couple v1 to an intentionally unexposed API.

The public `session.context` hook can mutate the outgoing request with system-role context, but those mutations are request-local rather than native durable transcript entries.

## Decision

Explicit consultation uses the real tool-call/tool-result path.

Automatic consultation in v1:

1. generates advice before the waiting primary Executor request proceeds;
2. stores the applicable automatic review in plugin-owned session/turn state;
3. injects that advice as system-role context through `session.context`;
4. reinjects it on relevant continuations during the same user turn;
5. lets a newer automatic review supersede the prior active review;
6. expires the active review on normal new user input.

The plugin must not:

- fabricate an `advisor()` call;
- deliver Advisor advice with `session.synthetic`;
- depend on the currently unexposed instruction-entry API.

The design should keep advice delivery replaceable so that a future OpenCode version can use native durable instruction entries if they become part of the supported plugin API.

## Alternatives considered

### Fabricate an Advisor tool call/result pair

Rejected because it falsely attributes the consultation decision to the Executor.

### Use session.synthetic

Rejected because OpenCode lowers synthetic messages to user-role context, which gives Advisor guidance the wrong semantic authority.

### Call the hidden/experimental instruction-entry endpoint directly

Rejected for v1 because normal plugins do not receive that capability through the supported Promise or Effect plugin context.

### Inject advice only once

Rejected because tool continuations cause later model requests in the same user turn; the Executor must continue to see the applicable review.

### Reinject all historical automatic advice forever

Rejected because it creates unbounded context growth and increases the risk of stale guidance.

## Consequences

- Automatic advice has appropriate system authority without falsifying transcript history.
- The plugin owns the lifetime of active automatic advice.
- Automatic advice is not natively persisted as an ordinary conversation message in v1.
- Same-turn state/expiry behavior requires explicit tests.
- Compaction does not require replaying all historical reviews; only the currently applicable review is reinjected.
- A future native delivery mechanism can replace the v1 delivery implementation without changing Jev or AdvisorService.

## Supersedes

None.

## Superseded by

None.
