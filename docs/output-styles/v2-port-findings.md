# Output Styles V2 Port: Findings

What we verified about Claude Code output styles and OpenCode V2 while porting `opencode-output-styles` to 2.0.0. Use it to re-check behavior after an OpenCode or Claude Code upgrade.

**Sources.** Each claim is marked:

- **verified**: observed live. OpenCode claims were exercised on 2.1.4 and 2.0.23 in an isolated `HOME`, with a mock model server logging every request, a probe plugin from a local registry, and a real TUI under tmux.
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
- `ctx.agent.get({ agentID }).data.system` tells you whether the agent has its own prompt. Built-in `optimize` uses the same check.
- Base-prompt sections differ by model family (`core/src/plugin/system-prompt/*.txt`, source):
  - Default: `# Harness`, `# Communication`, `# Working in codebases`.
  - Claude: default plus an appended `# Code comments`.
  - GPT: its own 39-line prompt, which also has `# Working in codebases`.
  - Kimi, Meta, Trinity: different headings.
- `# Harness` tells the model that `<system-reminder>` blocks are harness instructions.

### Sessions and storage (verified)

- `session.update({ metadata })` **replaces** the whole metadata object. Read, merge, then write.
- Child sessions (subagents) have `parentID` and **inherit** the parent's metadata, so a plugin that keys behavior off metadata must check `parentID`.
- The TUI's cached `data.session.get(id)` includes `metadata` at load. It does **not** re-render when metadata changes, but `data.on("session.metadata.updated")` does fire, so drive the UI from a signal fed by that event.
- `ctx.storage` is one global KV in `opencode.db`. A value set from one project directory reads back from another, and survives restarts.

### Server ↔ TUI (verified)

- A package listed only in `opencode.jsonc` gets its `./tui` entry loaded by the TUI automatically (`features.tui`).
- That TUI half receives `context.options = {}`. Options exist only on the server, so a server-side RPC is the way to hand them over.
- RPC calls go through `context.client.rpc(Def)` in the TUI, or `POST /api/rpc/:id/:method` with body `{ "input": … }` over HTTP.
- Every call needs an object input. A missing input fails with `rpc.invalid_input: Expected object`, and on the TUI client that surfaced as `[object Object]`.
- Sidebar click pattern: an element in `ui.slot({ append: "sidebar.content" })` with `onMouseUp → context.keymap.dispatch("<command id>")` runs the plugin's own command. The TUI's home footer does the same.
- `dialog.select` `actions` stay open when triggered.

### Versions and packaging (verified)

- `dialog.select` `actions` first appear in **2.0.23**. Everything else the plugin needs exists from 2.0.0, and `session.update` gained `metadata` in 2.0.15.
- Up to 2.0.24 the **server** does not serve `@opencode/plugin` as a virtual module. A server entry fails with `Cannot find package '@opencode/plugin'` unless the SDK is a **required** peer, which npm then installs.
- A required peer also works on 2.1.4, where the host module wins.
- Plugin installs use npm config through `@npmcli/config`, so `NPM_CONFIG_USERCONFIG` overrides `~/.npmrc` when testing against a local registry.
- No OpenCode built-in uses the name `output-style`.

## Where the port differs from Claude Code

| Topic | Claude Code | This plugin |
|---|---|---|
| Where the choice lives | `outputStyle` in settings files | Per-session `metadata.outputStyle`, plus a global default in plugin storage |
| Reminder timing | Every user prompt and after every tool batch, persisted | Appended to every user message in each outgoing request, not persisted |
| Custom reminder | Not possible | Optional `turn-reminder` frontmatter |
| `keep-coding-instructions: false` | Drops Claude Code's software-engineering section | Drops `# Working in codebases` and `# Code comments` from OpenCode's base prompt, never from an agent's own prompt |
| Project styles | Every `.claude/output-styles` from cwd to repo root | `<project>/.opencode/output-styles` only, plus the global config dir |

## Re-verifying

The sandbox recipe:

- Install `@opencode/cli-linux-x64@<version>` with `--ignore-scripts` and point `HOME` and every `XDG_*` variable at a scratch dir.
- Set `NPM_CONFIG_USERCONFIG` to a scratch `.npmrc` that points at a local verdaccio.
- Run a mock Anthropic Messages server that logs request bodies. Use provider package `@opencode/ai/providers/anthropic-compatible` on 2.1.x, and `@opencode/ai/providers/anthropic` on 2.0.23.
- Run `opencode serve` with `OPENCODE_PASSWORD`.
- Drive the TUI with `opencode --server <url>` in tmux. Clicks are SGR mouse sequences: `tmux send-keys -l $'\e[<0;COL;ROWM'`, then `…m`.
