# @capybearista/opencode-auto-advisor

OpenCode V2 server plugin that provides an independent Advisor for the Executor:

1. **Explicit consultation** — the Executor calls a zero-argument `advisor` tool.
2. **Automatic consultation** — an experimental routing layer consults the same
   Advisor at safe pre-provider session boundaries.

**Status: Phase 2 (#50).** Explicit consultation is implemented: the
zero-argument `advisor` tool captures the Executor's session context, consults a
fresh, stateless Advisor through `ctx.generate.text`, and returns the advice.
The routing domain is implemented as well: one `context` hook observer
fingerprints primary dispatches, applies the deterministic threshold policy, and
accounts a per-turn consultation budget. `observe` evaluates through the Zen
System One adapter and persists bounded telemetry; `active` additionally
consults the Advisor and injects accepted advice into the same user turn as a
system-role message through the `context` hook. The package is
**not published yet** and carries no release changeset. See
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
  transcript, excluding in-flight advisor tool calls, `inFlight` flags, and
  `idle` markers. An unchanged fingerprint is suppressed; a materially new tool
  result creates a new opportunity.
- **Policy** — the Advisor is consulted only when
  `advisorWouldHelp >= advisorWouldHelpThreshold` **and**
  `consequence >= consequenceThreshold`. Consequence uses a fixed 0-4 rubric:
  0 trivial, 1 minor/reversible, 2 moderate rework or user-visible mistake,
  3 serious (data loss risk, security-relevant, hard-to-reverse production
  impact), and 4 critical (irreversible harm, wide blast radius). Conservative
  defaults are 0.7 and 3.
- **Modes** — `off` only snapshots the request for explicit `advisor()` consults;
  `observe` evaluates and applies policy hypothetically without invoking the
  Advisor, and persists telemetry; `active` additionally consults the Advisor and
  injects accepted advice into the current dispatch as a system-role message
  (prefixed `[Auto Advisor automatic advice]`), reinjecting it on continuations
  within the same user turn.
- **Router** — `@opencode/ai` Evaluation + System One behind the `AdvisorRouter`
  seam. Two questions: a normalized boolean `advisor_would_help` and the 0-4
  `consequence` score rubric. The ordered `routing.models` chain restarts at the
  top on every opportunity; each model gets a bounded retry (transient
  RateLimit/ProviderInternal/Transport, honoring `x-should-retry`
  case-insensitively), quota exhaustion advances the chain immediately, and
  authentication, content-policy, invalid-request, and timeout failures fail
  open immediately. Every adapter call has a 30s caller deadline, so a hung
  provider call cannot hold the primary dispatch.
- **Reentrancy** — routing only runs on primary `context` dispatches. Advisor
  consultation and Zen evaluation run on host paths that do not fire that hook,
  and injected advice is never persisted, so neither automatic consultations nor
  their output can recursively create routing opportunities.
- **Telemetry** — bounded plugin-owned storage (5000 events, oldest-first
  eviction) storing the routing fingerprint digest, decision, policy values,
  router model, attempts, latency, error class, and delivery outcome — never the
  transcript. Read-only RPC at `experimental.auto-advisor`
  (`telemetry.query`/`telemetry.event`).
- **Budget** — `maxConsultationsPerTurn` (default 1) is keyed by session and the
  last user message; a new user message resets it. An accepted automatic attempt
  consumes the budget even if the consultation fails. Explicit `advisor()` calls
  never consume it.

Automatic failures fail open: routing, router, consultation, and injection errors
never block Executor continuation. Automatic advice is single-live-per-turn
plugin state that expires when a new user turn starts; it is injected into the
in-flight dispatch only, never persisted, and therefore can never re-trigger
routing. Non-persistence is a host contract verified on 2.0.19 (hook-time
dispatch mutations reach the model as tail content and are not written to
durable history), not a plugin-enforced invariant. Explicit `advisor()` failures
stay visible in the tool result.

## Requirements

- OpenCode V2 host (V1 is not supported)
- `@opencode/plugin` 2.0.19, `@opencode/ai` 2.0.19

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
