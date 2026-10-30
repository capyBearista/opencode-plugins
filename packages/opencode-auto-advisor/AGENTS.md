# opencode-auto-advisor — OpenCode plugin

**Technology**: TypeScript / OpenCode V2 plugin (server + TUI)
**Entry Points**: `src/server.ts` (server), `src/tui.ts` (TUI)
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: OpenCode >= 2.2.0 (2.x line, `latest`). No V1 line.

## Quick Reference

| Script              | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `bun run check`     | Lint and format (Biome)                   |
| `bun run lint`      | Validate without modifying                |
| `bun run typecheck` | Type check                                |
| `bun test`          | Run tests                                 |
| `bun run build`     | Declarations (tsc) + bundles (bun build)  |
| `bun run smoke`     | Build, then check both built entries load |

## Architecture

- `src/server.ts` wires everything: the `advisor` tool, a `prompt` hook that records the latest real prompt id, the `context` hook (route → consult → deliver, within the per-turn budget and the session step cooldown), an event subscription that ends stale consults, the `auto-advisor` RPC and telemetry.
- `src/decisions.ts`: the two Decision questions and the router over `routing.models`. `src/policy.ts`: the pure consult verdict.
- `src/transcript.ts`: the Decision projection (the real request, the turn's recent steps without system updates, and failure counts; no system prompt) and the Advisor transcript (system text, tool names, messages; compacted, then budgeted to `min(advisor.maxTokens, 75% of the window)` at 3 chars per token).
- `src/advisor.ts`: prompts and the timeout-raced consult. `src/delivery.ts`: review text, marker, tail push.
- `src/config.ts`: strict sparse `auto-advisor.json`, re-read when its mtime changes. `src/telemetry.ts`: JSONL with one rotation.
- `src/tui.ts`: footer status and the composer panel, driven only by RPC events.
- `src/rpc.ts` is the contract both halves import.

### Gotchas
- **Never edit `event.system`.** It breaks the provider's prompt cache. Reviews go to the tail of `event.messages` as a `role: "system"` message and to the `auto-advisor` instruction entry.
- **Entries put in the `context` hook land one step later.** The runner admits entry changes at the step boundary, before the hook (`core/src/session/runner/llm.ts` at v2.2.0). The tail push covers the current step, and the entry covers every later one.
- **Never append to the last message.** On a continuation step it is a `tool` message, and the Anthropic lowering accepts only tool-result parts there.
- **The `context` hook re-fires on a retried step.** The retry may already carry the entry from the failed attempt. `stateKey` ignores system messages and memoizes the outcome; the marker stops a second copy.
- **Hooks and `generate.*` calls can't be cancelled.** A consult that outlives its run is dropped by the session epoch, which is bumped on `session.execution.{succeeded,failed,interrupted}`.
- **Synthetic, skill, shell and compaction messages are `role: "user"` too**, and their metadata is dropped (`core/src/session/runner/to-llm-message.ts` at v2.2.0). A background subagent's result is one of them. The turn key and the Decision request use only the latest real prompt id: from the `prompt` hook, or, when the session predates the process (an OpenCode restart), the newest `type: "user"` message in `ctx.session.context`. Never fall back to the latest `role: "user"` message.
- **Our own reviews come back as system updates.** The Decision input leaves out system messages; otherwise a delivered review (`moment: done`) primes the next decision.
- **A failing shell command is not a tool error.** A non-zero exit, a kill or a timeout completes the tool with a notice at the end of the output (`core/src/shell/result.ts` at v2.2.0). The Decision input matches those notices (`SHELL_FAILURE`), and tool results are truncated from the start so the notice survives. Recheck the strings after an OpenCode upgrade.
- **The cooldown counts distinct steps.** A retry re-fires the `context` hook with the same `stateKey`; it is skipped, not counted.
- **`generate.text` without a model uses the global default**, not the agent's. Always pass the agent's `event.model` for "inherit".
- **A model ref without a variant gets no reasoning overlay** (the provider's default), not the agent's variant. `event.model` carries the agent's variant, so "inherit" keeps it; an unknown `#variant` fails the call with `InvalidRequestError` (`field: model.variant`).
- **`compactContext` matches OpenCode 2.2.0's rendered text**, not keys: the host joins its instruction sources into one system part, so the keys are gone by the `context` hook. The start and end strings come from `core/src/codemode/instructions.ts`, `mcp/instructions.ts` and `skill/instructions.ts`. A block is replaced only when its end comes before the next copy's start, so a wording change in the host costs tokens, never other context. Only full renders are matched; the host's incremental notices ("New skills are available…" and the like) are kept, at their small cost. Recheck the strings after an OpenCode upgrade.
- **Decision errors are plain objects with `_tag`.** A provider without credentials reports `Generate.ModelNotFoundError`, not an auth error. Shapes are in `src/fixtures/s1-decisions.json`.
- **The host retries rate limits itself.** The router never retries; it skips a throttled model for 60 s instead of stalling every step.
- **One `opencode.json` entry loads both halves**; `cli.json` needs none. The TUI gets `context.options = {}`, so configuration stays server-side.
- **Neither hook may throw into the user's request.** Failures are swallowed.

## Testing Guidelines

- Location: colocated (`src/*.test.ts`). `bunfig.toml` preloads `@opentui/solid/preload` for the TUI tests.
- Tests set `OPENCODE_CONFIG_DIR` and `XDG_DATA_HOME` to temp dirs; never read the real `HOME`.
- `src/server.test.ts` drives a fake host context. Request shapes match what a real 2.2.0 `context` hook delivers.
- Hook, delivery or protocol changes need a live check against real 2.2.0. The sandbox recipe and verified behavior are in [the findings doc](../../docs/auto-advisor/findings.md).
