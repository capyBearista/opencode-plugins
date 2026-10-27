# Output Styles V2 Port: Findings

What we verified about Claude Code output styles and OpenCode V2 while porting `opencode-output-styles` to 2.0.0, refining it in 2.1.0, and moving the style into a session instruction entry for OpenCode 2.2.0. Use it to re-check behavior after an OpenCode or Claude Code upgrade.

**Sources.** Each claim is marked:

- **verified**: observed live. OpenCode claims were exercised on 2.1.4 and 2.0.23 (2.2.0 for the instruction-entry section) in an isolated `HOME`, with a mock model server logging every request, a probe plugin from a local registry, and a real TUI under tmux.
- **binary**: read from the Claude Code 2.1.310 native binary (strings and byte slices; nothing executed beyond `--version`).
- **source**: read from OpenCode source at the `v2.1.4` tag (`anomalyco/opencode`), not exercised live.
- **docs**: from <https://code.claude.com/docs/en/output-styles> (snapshot in [`claude-output-styles.md`](claude-output-styles.md)).

## Claude Code (2.1.310)

### Built-in styles (binary)

| Style | `keepCodingInstructions` | Turn reminder |
|---|---|---|
| `default` | n/a, no style | none |
| Proactive | true | `Execute autonomously, minimize interruptions, prefer action over planning.` |
| Concise | true | `Be concise: lead with the result, skip preamble and narration, keep only what the user needs.` |
| Explanatory | true | none (fallback) |
| Learning | true | none (fallback) |

- Each prompt opens with `You are an interactive CLI tool that helps users with software engineering tasks.` and a `# <Name> Style Active` heading. The plugin's `built-in-styles/*.md` are those prompts, with template variables filled in.
- The plugin's descriptions drop Claude Code's leading "Claude" ("Claude explains…" becomes "Explains…"), because OpenCode runs any model. The prompts are unchanged.
- Proactive's body is the same text as Claude Code's auto-mode prompt. It also has a `waitingTurnReminder`, used while a background task is running. The port does not use it.
- The icons in the prompts are `★` (Insight) and `●` (Learn by Doing).
- Extract prompts from the binary **bytes**, not from `strings` output. `strings` drops lines shorter than 8 characters, which removes the blank lines.

### Custom styles (binary + docs)

- The frontmatter schema is strict: `name`, `description`, `keep-coding-instructions`, and `force-for-plugin` (plugins only). Custom styles cannot set a turn reminder.
- Merge order: built-ins, then plugin, user, project, and policy. A later style with the same `name` replaces the whole entry, so overriding `Explanatory` drops any built-in reminder (`h[V.name] = {name, description, prompt, source, keepCodingInstructions, forceForPlugin}`).
- `keep-coding-instructions: false` removes only Claude Code's software-engineering section. The rest of the system prompt stays.

### The per-turn reminder (binary)

- Text: `<Name> output style is active. <turnReminder ?? "Remember to follow the specific guidelines for this style.">`.
- It is sent as a hidden user-role message (`isMeta`). Claude Code 2.1.42 wraps it in `<system-reminder>`; the 2.1.310 wrapper was not traced.
- It is produced on every user prompt and after every tool batch while a non-default style is active. There is no turn counter.
- It is persisted in history, so the prefix stays stable and the reminders accumulate.
- It goes to the main thread only (`!agentId`), so subagents never get it. Forks inherit the parent's conversation.
- The style prompt itself also travels as an `output_style_instructions` attachment.
- **Unverified:** the exact 2.1.310 wire format, and what happens to these messages during compaction.

## OpenCode V2

### Request layout (verified)

`system` for a primary agent request on 2.1.4 is:

1. Base prompt: the agent's `system`, or the default prompt.
2. `# Your Model` (identity plugin).
3. `# Code Mode`.
4. Worktree guidance.
5. Root and global `AGENTS.md` plus `instructions`, when present.

Anything a plugin pushes comes after these.

- Root and global `AGENTS.md` are rebuilt into `system` on **every** request (`core/src/session/model-request.ts:92-110`, source).
- Nested `AGENTS.md` files found while reading subfolders are injected **once**, as synthetic messages, and re-injected only if compaction drops them (`core/src/session/instructions.ts`, source).
- The title request is separate. It has its own system prompt and no tools, and it fires the `title` hook, not `context`.

### Hooks (verified)

- `session.hook("context")` fires before every agent-loop request, including the request after a tool result. Async callbacks are allowed.
- It changes only the outgoing request; nothing is saved to stored history.
- Callbacks run in registration order (`core/src/plugin/hooks.ts:88-94`). Built-in plugins register first, so an external plugin's hook sees `system[0]` after `optimize` has rewritten or extended it. With a `claude*` model id, `system[0]` grew by the 302-character `# Code comments` append before our hook ran.
- Appending a text part to each user message in the hook kept requests byte-identical in prefix across turns (with `cache_control` ignored).
- Tool results did not show up as plain user text messages. Only real user prompts got the appended part.
- Real prompts are not the only `role: "user"` messages, though (`core/src/session/runner/to-llm-message.ts:240-310`, source).
  - Synthetic messages (plan-mode and agent-switch reminders, nested `AGENTS.md`), skill text, user shell output, compaction summaries and location switches are all sent as `role: "user"`.
  - Each carries its session message `id`, and harness-spliced messages such as plan mode's carry none.
  - To target only prompts, match ids against `ctx.session.context({ sessionID })` entries with `type: "user"`. That call exists from 2.0.23 and returned in about 6 ms on a small session (verified).
- `ctx.agent.get({ agentID }).data.system` tells you whether the agent has its own prompt. Built-in `optimize` uses the same check.
- Base-prompt sections differ by model family (`core/src/plugin/system-prompt/*.txt`, source):
  - Default: `# Harness`, `# Communication`, `# Working in codebases`.
  - Claude: default plus an appended `# Code comments`.
  - GPT: its own 39-line prompt, which also has `# Working in codebases`.
  - Kimi, Meta, Trinity: different headings.
- `# Harness` tells the model that `<system-reminder>` blocks are harness instructions.

### Instruction entries and the prompt cache (verified on 2.2.0)

Editing `event.system` in the `context` hook works, but any change to it invalidates the provider's cached prefix from that block on. Measured with the 2.1.0 plugin: after an Explanatory → Concise switch, only the tools and the first four system blocks were reused (5 of 17 blocks); everything after was sent uncached once. The rewritten reminders on every earlier prompt broke the cache on their own too.

- `ctx.session.instructions.entry.put/list/remove` (new in 2.2.0) attach keyed text to a session. Entries load when a step starts (`SessionContext.select` in `core/src/session/context.ts`, source), before the `context` hook runs, so an entry changed inside `context` only shows on the next step.
- The `prompt` hook runs in `SessionPrompt.prepare`, before the prompt is admitted (`core/src/session/prompt.ts`, source). An entry put there applies to that same turn.
- On a session's first step the entry is rendered at the end of the system prompt as `<context key="output-style">…</context>`. A later change or removal is appended as a user-role `<system-update>` just before the next prompt ("…changed and supersedes the previous value", "…no longer applies. Disregard it."). Earlier content is never edited.
- Update bodies are XML-escaped (`&lt;context …&gt;`) so they cannot close the wrapper (`packages/ai/src/protocols/shared.ts:189-199`, source). A style whose text uses `<`, `>` or `&` reaches the model escaped after a mid-session switch.
- Metadata a `prompt` hook sets on `event.metadata` is stored on the user message and comes back from `ctx.session.context()`. The plugin records each turn's reminder there and re-attaches exactly that text, so old reminders never change.
- With both changes, 11 consecutive requests in one session reused 100% of the previous request, across a session switch, a switch to None, a return to the global setting, and a change of the global setting.
- After compaction, history restarts from the summary and the entry is rendered again in the system prompt from its current value. The break at compaction is compaction's own.
- Forks copy the parent's entries but not its metadata (the fork's `metadata` was `{}`), so a fork follows the global setting from its first prompt.
- A subagent's child session got no entry and no reminder, and its prompt did not fire the plugin's `prompt` hook.
- An agent with its own `system` keeps it; the entry is added after it.

### Sessions and storage (verified)

- `session.update({ metadata })` **replaces** the whole metadata object. Read, merge, then write.
- Child sessions (subagents) have `parentID` and **inherit** the parent's metadata, so a plugin that keys behavior off metadata must check `parentID`.
- The TUI's cached `data.session.get(id)` includes `metadata` at load. It does **not** re-render when metadata changes, but `data.on("session.metadata.updated")` does fire, so drive the UI from a signal fed by that event.
- `ctx.storage` is one global KV in `opencode.db`. A value set from one project directory reads back from another, and survives restarts.

### Server ↔ TUI (verified)

- A package listed only in `opencode.jsonc` gets its `./tui` entry loaded by the TUI automatically (`features.tui`).
- An absolute path to a built package directory in `plugins` loads both halves the same way (verified on 2.1.4).
- That TUI half receives `context.options = {}`. Options exist only on the server, so a server-side RPC is the way to hand them over.
- RPC calls go through `context.client.rpc(Def)` in the TUI, or `POST /api/rpc/:id/:method` with body `{ "input": … }` over HTTP.
- Every call needs an object input. A missing input fails with `rpc.invalid_input: Expected object`, and on the TUI client that surfaced as `[object Object]`.
- **RPC calls are routed by location.** A shared server runs one plugin instance per project location, and a call without `location` reaches the server's default project.
  - A TUI viewing another project then reads and writes that default project's styles (verified).
  - Pass `{ location }` as the second argument. Use the session's own `location` for session-scoped calls, else `context.location ?? context.data.location.default()`. That fallback is the pattern OpenCode's own TUI plugins use.
  - `session.create` takes its location from the body `location`, not from the `x-opencode-directory` header (verified).
- **Viewing a subagent session keeps the route on the parent.** `ui.router.current()` reports the parent's `sessionID`, so a command run there targets the parent (verified with a probe). The child view has no prompt box and no sidebar.
- Sidebar click pattern: an element in `ui.slot({ append: "sidebar.content" })` with `onMouseUp → context.keymap.dispatch("<command id>")` runs the plugin's own command. The TUI's home footer does the same.
- `dialog.select` `actions` stay open when triggered.

### Versions and packaging (verified)

- The 2.2.0 floor comes from `ctx.session.instructions.entry`. On 2.1.4 the `prompt` hook exists but `session.instructions` does not, so the plugin loads, prompts still go through, and no style is applied (verified on 2.1.4). Before 2.2.0 the floor was 2.0.23, from `ctx.session.context`.
- Up to 2.0.24 the **server** does not serve `@opencode/plugin` as a virtual module. A server entry fails with `Cannot find package '@opencode/plugin'` unless the SDK is a **required** peer, which npm then installs.
- A required peer also works on 2.1.4, where the host module wins.
- Plugin installs use npm config through `@npmcli/config`, so `NPM_CONFIG_USERCONFIG` overrides `~/.npmrc` when testing against a local registry.
- No OpenCode built-in uses the name `output-style`.

## Where the port differs from Claude Code

| Topic | Claude Code | This plugin |
|---|---|---|
| Where the style text goes | `output_style_instructions` attachment | A session instruction entry, never the system prompt |
| Where the choice lives | `outputStyle` in settings files | Per-session `metadata.outputStyle`, plus a global setting in plugin storage, changed from the home screen |
| Name for "no style" | `Default` | `None` ("default" was ambiguous next to the global setting) |
| Reminder timing | Every user prompt and after every tool batch, persisted | Recorded on each user prompt when sent and re-attached unchanged to that prompt in every request; none after tool batches |
| Custom reminder | Not possible | Optional `turn-reminder` frontmatter |
| `keep-coding-instructions: false` | Drops Claude Code's software-engineering section | Not supported since plugin 2.2.0. Removing base-prompt sections edits the system prompt, which breaks the prompt cache, and the heading match only covered the default, Claude and GPT prompts |
| Project styles | Every `.claude/output-styles` from cwd to repo root | `<project>/.opencode/output-styles` only, plus the global config dir |

## Re-verifying

For a quick check in your own setup, use [Testing in OpenCode](../../CONTRIBUTING.md#testing-in-opencode). To re-check the claims above in isolation, use the sandbox recipe:

- Install `@opencode/cli-linux-x64@<version>` with `--ignore-scripts` and point `HOME` and every `XDG_*` variable at a scratch dir.
- Set `NPM_CONFIG_USERCONFIG` to a scratch `.npmrc` that points at a local verdaccio.
- Run a mock Anthropic Messages server that logs request bodies. Use provider package `@opencode/ai/providers/anthropic-compatible` on 2.1.x, and `@opencode/ai/providers/anthropic` on 2.0.23.
- Run `opencode serve` with `OPENCODE_PASSWORD`.
- Drive single turns with `opencode run --server <url> --session <id> "…" < /dev/null`. With an open non-TTY stdin, `run` can wait and never send the prompt.
- Drive the TUI with `opencode --server <url>` in tmux. Clicks are SGR mouse sequences: `tmux send-keys -l $'\e[<0;COL;ROWM'`, then `…m`.
