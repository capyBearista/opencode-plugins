# Auto Advisor: verified OpenCode 2.2.x behavior

Verified 2026-10-28 on `@opencode/cli@2.2.0` with an isolated HOME/XDG, a local mock executor (OpenAI chat and Anthropic messages endpoints that log request bodies) and real OpenCode Zen. The design in `packages/opencode-auto-advisor` rests on these facts; re-check them before changing hooks, delivery or the router.

## S1 — `ctx.experimental.generate.decisions` with `opencode/jev-1.13-free`
- Anonymous works, no Zen login. `cost: 0`, `native.opencode.usage.opencode.billing_source: "free"`.
- Latency: first call 2.8 s (cold); next 9 calls 112–350 ms (median ~155 ms). ~500 input tokens / 65 output.
- Answer shapes match the schema: choice `{choice, probabilities[], confidence}`, score `{score (raw, e.g. 2.49), probabilities[], confidence}`. Plugin bridge returns `{answers, cost, tokens, native}`; HTTP wraps it in `data`.
- Errors arrive as plain objects with `_tag` (+ `message`, fields):
  - unknown model or provider → `Generate.ModelNotFoundError`
  - chat model → `Generate.UnsupportedModelError` (`capability: "decision"`)
  - provider without credentials (openrouter, no key) → `Generate.ModelNotFoundError` (provider not in catalog), not an auth error
  - bad request shape → `SchemaError` (client-side, before the host)
  - input too large → `Generate.ProviderRequestError` `reason: "invalid_request"` (HTTP 400 `max_tokens`)
- Input size: 100k chars accepted; 250k rejected. The projection has no total cap since round 3: a request too large for one decision model fails over to the next in `routing.models`; `routing.requestMaxChars` caps each request when needed.
- S1b (8 synthetic cases, smoke only): moment 8/8 correct. Consequence: prod migration 3.81, key rotation 2.8, rate-limit design 2.1, both "stuck" cases ~1.85, CLI flag done 0.52, routine 0.4–1.1.

## S2 — delivery timing (OpenAI chat mock)
- Tail `{role:"system"}` pushed in the `context` hook at step N is in step N's request (as a user-role `<system-update>`, XML-escaped).
- `entry.put` in the hook at step N is admitted at step N+1 as a durable `<system-update><context key="auto-advisor">…` placed after step N's tool result, and stays at that index in later requests.
- Prefix: consecutive primary requests share the whole prefix except the ephemeral tail; tools identical.
- Hook payload: user/assistant messages carry ids; `tool` messages have none; admitted entries appear as `role:"system"` with an id.
- A provider 503 retry re-fires the `context` hook, and the retry already includes the entry put during the failed attempt (dedupe marker needed). On retry the entry is placed before that step's reply, then moves after it → one-time prefix break, retry case only.

## S3 — reentrancy and events
- `generate.text` from inside the `context` hook does not fire the plugin's hooks.
- Event names: `session.execution.{started,succeeded,interrupted,failed}`; also `session.step.{started,ended}`, `session.instructions.updated`.

## S4 — explicit tool context
- Tool ctx keys: `sessionID, agent, messageID, id, progress, signal`.
- `ctx.session.context()` during execution includes the in-flight assistant message (`id === toolCtx.messageID`, tool state `running`).
- Prompt hook: `{sessionID, messageID, prompt, metadata, delivery}`; `delivery: "steer"` for `opencode run`.

## S5 — protocols
- Anthropic, Claude 4.6: tail system message merged into the tool-result user turn as a text block, escaped.
- Anthropic, Claude 5.5: native mid-conversation `system` message, not escaped.
- OpenAI chat: user-role `<system-update>`, escaped.

## Live check of the built plugin (2026-10-28)
- One `plugins` entry in `opencode.json` loads both halves: `/api/plugin` reports `features: {server: true, tui: true}`.
- `active` with thresholds at 0 and real Jev: step 1 and step 2 each got a review at the tail of their own request; each review became a durable entry from the next step on; the budget stopped at 2. Across primary requests the system prompt and tools were byte-identical and only the newest tail message changed.
- `observe` with an explicit `advisor()` call from the mock: no request was changed, telemetry was written, and the Advisor's prompt contained the in-flight `TOOL CALL advisor`; its advice came back as the tool result.
- Interrupt during a consult (`POST /api/session/:id/interrupt`, Advisor reply held 20 s): `session.execution.interrupted` aborted the consult after 4.4 s, telemetry recorded `stale`, nothing was delivered, and the interrupted step sent no model request.
- Not covered live: compaction and child sessions. `src/server.test.ts` covers child sessions and a turn surviving a compaction that drops its prompt (a request shape built by hand, not captured from the host).

## Live check of the decision fixes and the TUI (2026-10-30, OpenCode 2.2.0)
- A failing shell command reached the model as `24 passed, 1 failed\n\nExited with code 1` (tool completed, no error), the string `SHELL_FAILURE` matches. Real Jev read that step as `stuck` 0.65, `done` 0.
- With the per-turn budget spent, the next step logged `verdict: "blocked"`, `blocked: "budget"`, without a consult.
- After a server restart, a synthetic message (`POST /api/session/:id/synthetic`) started a run: the turn stayed the real prompt's id, read from `ctx.session.context` (`type: "user"`), not the synthetic message's.
- TUI (`opencode --server … -s <session>` in a 180-column tmux): the `sidebar.footer` widget showed `Advisor ✓ done 02:50`; a click (SGR mouse sequence) and `/advisor-review` opened the panel; the advice rendered as markdown and scrolled to its last line with the wheel; `f` toggled full screen, Esc closed it; `tui.sidebar: false` hid the widget while `/advisor-review` still worked.

## Re-verify recipe
1. `npm i @opencode/cli@2.2.5` (the minimum) in a scratch dir. Set `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` to a scratch home.
2. In the scratch `opencode.json`: `"plugins": ["<repo>/packages/opencode-auto-advisor"]`, a `mock` provider on `@opencode/ai/providers/openai-compatible` (or `/anthropic`) with `baseURL` at a local mock, and `"model": "mock/<id>"`.
3. The mock logs every request body. For requests with `tools`, it answers with a tool call for the first two steps, then text; for requests without tools (title, Advisor), it answers with text.
4. Start `opencode serve --port <p>`, read the password from its output, then `OPENCODE_PASSWORD=… opencode run --server http://127.0.0.1:<p> "<prompt>" < /dev/null`. Without `< /dev/null`, `run` can hang on an open stdin.
5. Decision calls can be sent directly: `POST /api/experimental/generate/decisions?directory=<project>` with basic auth `opencode:<password>`; the response wraps the result in `data`.
6. Kill servers by pid, not `pkill -f`, which can match the shell running the command.
7. After an OpenCode upgrade, check that `compactContext`'s strings in `src/transcript.ts` still match `core/src/codemode/instructions.ts`, `mcp/instructions.ts` and `skill/instructions.ts`: run one explicit `advisor()` consult and confirm the Advisor's prompt has the three `[context-omitted: …]` markers. A mismatch only stops the compaction.
8. Also check `SHELL_NOTICE` in `src/transcript.ts` against `core/src/shell/result.ts` (`Exited with code N`, `Killed by …`, `Timed out before completion`), that `tool/plugin/shell.ts` still emits the notice as its own text part, that `plugin/tool-input-repair.ts` still aliases only `bash` to `shell`, and that `to-llm-message.ts` still lowers synthetic and shell messages to `role: "user"` while `ctx.session.context` keeps their `type`. A mismatch hides failed commands from the Decision model.

## Live check of round 3 (2026-10-31, OpenCode 2.2.0)
- Advisor chain `["dead/x" (port 9), "mock/overflow", "mock/silent", "mock/keepalive"]`, provider `headerTimeout`/`chunkTimeout` 1500 ms, `advisor.timeoutMs` -1:
  - `dead/x`: `ProviderRequestError (provider)` after 12.5 s, because the host retries a refused connection (`retryOneShot`).
  - `mock/overflow` (HTTP 400 `context_length_exceeded`): `ProviderRequestError (invalid_request)` after 33 ms; moved on.
  - `mock/silent` (headers, then nothing): ended by the chunk timeout after 1.5 s; moved on.
  - `mock/keepalive` (SSE comments for 4 s, then text): answered after 4.2 s, so keep-alives keep a slow model alive past `chunkTimeout`. The panel and telemetry named `mock/keepalive`.
- A long plan prompt (8,266 chars), then `opencode run --session … "Leave .slim/deepwork/ unignored."`: the second turn's Decision input held the whole plan and the correction (8,372 chars of requests); the turn was the correction's id.
- Real `opencode/jev-1.13-free` with a 300,180-char input: `ProviderRequestError (invalid_request)` in 296 ms, and the router moved to the next model. A decision model declared in config (`"type": "decision"` under `providers.openrouter.models`) resolved as `Generate.UnsupportedModelError`, so a mock decision model could not be tested.
- TUI: the sidebar widget is one line (`Advisor ✓ approach 11:03`); a click opened the panel.
- `bun run timeline <session>` read the telemetry and `opencode api get …/message` and wrote the page; each step listed the messages since the previous one.

## Recheck on OpenCode 2.2.5 (2026-10-31)
- Diffed v2.2.0..v2.2.5 for every host file the plugin relies on.
  - **Changed:** the Code Mode catalog text (`core/src/codemode/instructions.ts`). It now starts "The tools listed below… cannot be called directly", and its header is now `## Code Mode tools (call only inside \`execute\`)`. With the 2.2.0 strings, compaction of that catalog silently stopped. The plugin now requires 2.2.5 and matches the new text.
  - **Unchanged:**
    - shell notices (`shell/result.ts`);
    - the subagent wrapper;
    - the `prompt` hook;
    - message ids and the lowering of user, synthetic, skill and shell messages;
    - the generate errors, `retryOneShot`, and the header and chunk timeouts;
    - the message list API (a cursor still can't be combined with `order`);
    - the event stream closing after a read error;
    - the MCP and skill catalog text.
  - **New, not used yet:** the instructions system part keeps each source as `metadata.experimental.instructions` (`{key, text}`).
  - **Also new:** a tool call named `bash` runs `shell` but keeps the name `bash`.
- Live, on `@opencode/cli@2.2.5`, with a probe MCP server (Code Mode on) and a probe skill:
  - The Advisor prompt had all three `[context-omitted …]` markers and no raw Code Mode, MCP or skill catalog text.
  - A shell command that exited 3 reached the hook as a two-part content result (`(no output)`, `Exited with code 3`) and counted as failed.
  - A `read` of a file containing `Exited with code 1` counted as ok (`Latest tool result: ok`). The 2.2.5 `read` argument is `path`.
  - TUI (OpenTUI 0.8): the one-line widget showed `Advisor ✓ stuck 15:28`, a click opened the panel, and the markdown advice rendered.

## Known limitations
- A prompt that a summary compaction absorbs before any step sees it never starts its own turn. The turn is the newest real prompt present in the request (`server.ts`); when none is present it carries on from the last one, so the earlier turn's spent budget and step count continue and the Decision requests block reads `(not in context)` until the next prompt. Accepted as rare and fail-closed (fewer consults, never more).
- `opencode-ram-monitor` builds its modal with `insert(markdown, [])`, the call that blanked this plugin's panel. On 2.2.0 the `/ram` modal still renders its text (checked live 2026-10-31), because its content changes once, when the async load finishes after the insert, which redraws the blocks; not changed.
