# Server, TUI, and prompt state

One OpenCode V2 server plugin entry loads both the server and TUI halves. The server owns configuration and persistence; the TUI consumes state through the RPC contract in `src/rpc.ts`.

A style change updates an instruction entry and appends a current-turn reminder; it must not rewrite system prompts or previously seen prompt content. Check the exact `prompt` and `context` hook timing, and avoid confusing session metadata with globally stored defaults.

Subagent sessions do not own style selection, session metadata is a shared object, and TUI caches need explicit update signals. Inspect both sides of any changed contract.

Bundled `built-in-styles/*.md` are published assets derived from an identified upstream snapshot. A deliberate prompt refresh is different from an incidental reformat.
