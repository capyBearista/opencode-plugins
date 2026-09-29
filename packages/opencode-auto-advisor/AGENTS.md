# opencode-auto-advisor — OpenCode plugin

**Technology**: TypeScript / OpenCode V2 Plugin (`@opencode/plugin` 2.0.18)
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

Phase 1C implemented: the routing domain and observer sit alongside the Phase 1B
explicit path. Explicit `advisor()` works end to end — strict global
configuration, Executor context capture/serialization with media placeholders,
Executor-model inheritance, and a stateless `AdvisorService` over
`ctx.generate.text`. `ctx.session.hook("context")` now observes primary
dispatches to fingerprint routing state, apply the deterministic policy, and
account the per-turn consultation budget: `off` short-circuits, `observe`
evaluates hypothetically without invoking the Advisor, and `active` performs the
automatic consultation without delivering advice yet. The Zen/System One
`AdvisorRouter` adapter, telemetry, RPC, TUI, storage, and advice delivery are
intentionally absent and tracked by the execution contracts in
[../../docs/plans/opencode-auto-advisor.md](../../docs/plans/opencode-auto-advisor.md).
Add a Changeset only when the package becomes releasable.

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
├── context.ts          # Session read → captured, serialized context
├── messages.ts         # Host message/tool shapes derived from @opencode/plugin types
├── serialize.ts        # Canonical deterministic transcript serializer
├── serialize-assistant.ts
├── media.ts            # Media placeholders; raw bytes never leave this module
├── advisor-service.ts  # Fresh/stateless consultation service
├── routing-types.ts    # AdvisorRouter seam, decisions, 0-4 consequence anchors
├── router.ts           # Router result normalization (clamp/reject)
├── fingerprint.ts      # Routing fingerprint + preimage composition
├── routing.ts          # Modes, opportunity gating, policy, per-turn budget
├── routing-observer.ts # ctx.session.hook("context") wiring
└── *.test.ts           # Colocated bun tests
```

- `src/index.ts` — default export is
  `Plugin.define({ id: "capybearista.opencode-auto-advisor", setup })`;
  `registerPlugin(context)` registers the zero-argument `advisor` tool through
  `context.tool.transform`, registers the routing observer, and returns an
  idempotent dispose function that disposes the hook before the tool. The plugin
  creates one shared `AdvisorService` per setup; the tool and the automatic path
  both resolve through it, and `buildAdvisorService` is the shared seam.
- Advisor context is the actual Executor history returned by
  `ctx.session.context`, serialized chronologically. The assistant message that
  carries the `advisor()` call is marked `inFlight: true`, so same-turn
  assistant text before the call survives capture. Compaction entries include
  checkpoint provenance; the provider-native checkpoint blob is omitted.
- `serializeAdvisorContext` and `stableStringify` are pure, deterministic
  (sorted keys) exports so routing fingerprints build on the same canonical
  form. `SerializedEntry` carries an optional `origin: "advisor"` tag that the
  serializer passes through and the fingerprint excludes; automatic delivery
  (Phase 2) uses it.
- Media (images, audio, video, documents) becomes metadata placeholders with
  `inspected: false`; base64 payloads and provider-native blobs never reach the
  prompt.
- Explicit-consultation failures — session read, configuration, or generation —
  are returned as a visible `Auto Advisor consultation failed: …` tool result
  with `metadata.error`; they are never thrown past the tool boundary.

## Routing (Phase 1C)

- Boundary: exactly one `ctx.session.hook("context", …)` observer. On
  `@opencode/plugin` 2.0.18 the host only fires this hook for primary agent-loop
  dispatches (compaction, title, and generate dispatches have their own hook
  names), so a payload without `kind` is treated as primary; a payload that
  carries any other `kind` is skipped defensively.
- Modes: `off` short-circuits before any session read; `observe` captures,
  fingerprints, evaluates, and applies policy hypothetically with zero Advisor
  invocations and zero context mutations; `active` additionally performs the
  automatic consultation. No mode delivers advice yet.
- Fingerprint: `routingFingerprint(entries)` canonicalizes the fingerprint
  preimage. The preimage preserves transcript order and drops the in-flight
  advisor tool-call block, `inFlight` flags (normalized to `false`), entries
  flagged `origin: "advisor"`, and `idle` markers; `model-switched` and other
  markers stay. Identical fingerprints are suppressed, so a failed or completed
  opportunity is never retried against unchanged state.
- Consequence anchors (the `consequence` router answer is an integer 0-4):

  | Level | Summary | Guidance |
  | --- | --- | --- |
  | 0 | trivial | No meaningful consequence; proceeding without review costs nothing |
  | 1 | minor | A minor inconvenience that is easily reversed |
  | 2 | moderate | Moderate rework or a mistake visible to the user |
  | 3 | serious | Data loss risk, security-relevant, or hard-to-reverse production impact |
  | 4 | critical | Irreversible harm with a wide blast radius |

- Policy: `consult = advisorWouldHelp >= routing.advisorWouldHelpThreshold AND
  consequence >= routing.consequenceThreshold`, read from live configuration for
  every opportunity. `advisorWouldHelp` is clamped to `[0, 1]`; a non-integer or
  out-of-range consequence is a router error.
- Budget: keyed by `(sessionID, last-user-message-id)`. A new user message
  resets the turn. The budget is checked after policy: rejected opportunities
  never consume it, and budget-exhausted opportunities are still evaluated so
  `observe` can record what `active` would have done. An accepted opportunity
  consumes one attempt whether the automatic consultation succeeds or fails;
  explicit `advisor()` never consumes. Router errors, capture failures, and
  configuration errors fail open without consuming an attempt, and the
  fingerprint is still recorded so the same state is not retried.
- Router seam: stable code depends on
  `AdvisorRouter.evaluate(state) → { advisorWouldHelp, consequence, metadata? }`.
  The OpenCode `@opencode/ai` Evaluation/System One adapter lands in Phase 2 and
  must stay behind this seam; until then the plugin installs a router that fails
  open.
- Phase 1 performs no provider calls beyond `ctx.generate.text` on the
  configured-or-inherited Advisor model; no Zen/paid-only routing calls exist.
  `routing.models` is validated but unconsumed until the #50 adapter.

## V2 Install and Compatibility

- This package is **V2-only** and targets `@opencode/plugin` **2.0.18**, the
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
  plugin id, the zero-argument tool contract, and exactly one `context` hook,
  executes a consultation through `session.context` + `generate.text` with
  executor-model inheritance, fires frozen primary/auxiliary dispatches in all
  three modes (off performs zero session reads and zero generation; no mode
  mutates the dispatch), and verifies cleanup disposes the hook and tool
  registrations.

## License

MPL-2.0
