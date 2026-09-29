# @capybearista/opencode-auto-advisor

OpenCode V2 server plugin that provides an independent Advisor for the Executor:

1. **Explicit consultation** — the Executor calls a zero-argument `advisor` tool.
2. **Automatic consultation** — an experimental routing layer consults the same
   Advisor at safe pre-provider session boundaries.

**Status: Phase 1C.** Explicit consultation is implemented: the zero-argument
`advisor` tool captures the Executor's session context, consults a fresh,
stateless Advisor through `ctx.generate.text`, and returns the advice. The
routing domain is implemented as well: one `context` hook observer fingerprints
primary dispatches, applies the deterministic threshold policy, and accounts a
per-turn consultation budget. `observe` evaluates without invoking the Advisor,
and `active` performs the automatic consultation, but advice delivery,
telemetry, and the Zen `AdvisorRouter` adapter are not implemented yet. The
package is **not published yet** and carries no release changeset. See
[`../../docs/plans/opencode-auto-advisor.md`](../../docs/plans/opencode-auto-advisor.md)
for the governing plan.

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

- **Fingerprint** — each dispatch is fingerprinted over the canonical serialized
  transcript, excluding in-flight advisor tool calls, `inFlight` flags, `idle`
  markers, and entries flagged as advisor origin. An unchanged fingerprint is
  suppressed; a materially new tool result creates a new opportunity.
- **Policy** — the Advisor is consulted only when
  `advisorWouldHelp >= advisorWouldHelpThreshold` **and**
  `consequence >= consequenceThreshold`. Consequence uses a fixed 0-4 rubric:
  0 trivial, 1 minor/reversible, 2 moderate rework or user-visible mistake,
  3 serious (data loss risk, security-relevant, hard-to-reverse production
  impact), and 4 critical (irreversible harm, wide blast radius). Conservative
  defaults are 0.7 and 3.
- **Modes** — `off` does nothing; `observe` evaluates and applies policy
  hypothetically without invoking the Advisor; `active` performs the automatic
  consultation, but advice delivery is not implemented yet.
- **Budget** — `maxConsultationsPerTurn` (default 1) is keyed by session and the
  last user message; a new user message resets it. An accepted automatic attempt
  consumes the budget even if the consultation fails. Explicit `advisor()` calls
  never consume it.

Automatic failures fail open: routing, router, and consultation errors never
block Executor continuation or mutate context.

Phase 1 performs no provider calls beyond `ctx.generate.text` on the
configured-or-inherited Advisor model; no Zen/paid-only routing calls exist.
`routing.models` is validated but unconsumed until the #50 adapter.

## Requirements

- OpenCode V2 host (V1 is not supported)
- `@opencode/plugin` 2.0.18

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
