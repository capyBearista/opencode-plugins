# OpenCode V2 Plugin Runtime Notes

What a V2 plugin can rely on at runtime: which process it runs in, where options come from, how entries resolve, and how OpenCode's own processes are laid out. Written while porting `opencode-ram-monitor` to OpenCode 2.1.

**Sources.** File references point at the OpenCode `v2.1.4` tag (`anomalyco/opencode`). Each claim is marked:

- **verified**: observed live against OpenCode 2.1.4 in an isolated `HOME`, with a real TUI under a pty and a probe plugin.
- **source**: read from the code, not exercised live.

The `services/www` docs describe V2. The older `packages/web` docs still describe V1 (`tui.json`, `@opencode-ai/plugin`).

## Process model

| Mode | How it starts | Server process | Parent of the server |
| --- | --- | --- | --- |
| Default (shared service) | First client runs `<opencode> serve --service` | One per user, shared by every local TUI | Whichever process started it; detached, so it is re-parented to init once that process exits **(verified)** |
| `--standalone` | The TUI spawns `<opencode> serve --stdio --port 0` | One per TUI | The TUI **(verified)** |
| `--server <url>` | Nothing is spawned | Wherever the URL points, possibly another machine | Not local **(source: `packages/cli/src/services/server-connection.ts`)** |

- The service is spawned with `detached: true` (`packages/client/src/service-contender.ts:20`). On Linux it keeps its spawner as parent until that process exits. Never assume the server is, or is not, a child of the TUI.
- In the bundled npm install, the server's command line is `<install>/bin/opencode.exe serve --service`, even on Linux. In the curl install it is `~/.opencode/bin/opencode serve --service`, and the TUI's is just `opencode`. V1's separate `.opencode` core binary is gone **(verified)**.
- The server owns sessions and tool execution. MCP servers, language servers, and agent shell commands are spawned under the server process **(verified for MCP; source for shell: `packages/core/src/shell.ts:310`)**.
- Persistent terminals run in a separate `opencode-pty daemon --runtime-dir <state>/pty --name <uuid>` process. The server spawns it detached (`packages/core/src/persistent-pty/daemon.ts:237`), and it survives server restarts, after which it is no longer under the server **(source)**.
- Lock entries under `~/.local/state/opencode/locks/` are directories, not files that hold a PID **(verified)**.

## What a TUI plugin gets

- **It runs inside the TUI process.** `process.pid` is the TUI, and child processes the plugin spawns (such as `ps`) appear under it **(verified)**.
- **`context.client` talks to the server this TUI uses.** `client.server.info()` returns `{ version, pid, urls }`, where `pid` is the server's own process ID, so a plugin can find the server it is connected to **(verified, standalone and shared service)**. It first ships in `@opencode/client` 2.1.0. In 2.0.x the closest call is `client.health.get()`.
- **`context.client` is captured once.** The context stores `host.client.api` when the plugin activates (`packages/tui/src/plugin/api.tsx:159`). It is not a getter, and plugins are not re-activated when the TUI reconnects. In practice it keeps working across `opencode service restart`, because the default service keeps a fixed port and a password persisted in `<config>/service.json` **(verified)**. A changed port or password would leave it stale **(source)**.
- **`context.options`** is the `options` object of the plugin's `cli.json` entry, or `{}` (`packages/tui/src/plugin/api.tsx:153`). Plugins loaded only from the server's inventory get no options (`packages/tui/src/plugin/context.tsx:301-305`).
- **`setup` is awaited** before the plugin is active (`packages/tui/src/plugin/context.tsx:639-641`). Register slots synchronously and do I/O inside components (see the [IPC guide](./opencode-plugin-ipc-and-os-patterns.md)).

## Config and options

- TUI plugins are listed in the global `cli.json` only. There is no project-level `cli.json` **(source: `services/www/src/docs/content/cli/config.mdx`)**.
- A `plugins` entry is a string or `{ "package": "...", "options": { ... } }` (`packages/tui/src/config/index.tsx:47-55`).
- **A V1 tuple entry voids the whole file.** `cli.json` is decoded all-or-nothing (`packages/cli/src/config/config.ts:22, 65`). One `["pkg", { ... }]` entry makes OpenCode ignore the file entirely: theme, keybinds, and every plugin **(verified: a probe plugin listed next to a tuple never loaded)**. Document the object form in every README that shows options.
- **Editing options re-activates the plugin live.** The host compares options between generations (`packages/tui/src/plugin/context.tsx:726-735`) and re-runs `setup` with the new values, so a plugin needs no config-file watcher **(verified)**.

## Entry resolution

`Host.resolve` (`packages/plugin/src/host.ts:43`, exported as `@opencode/plugin/host`) looks for:

- **server**: `<pkg>/server`, then the package root (`<pkg>`, or `index` for a local directory)
- **tui**: `<pkg>/tui`
- **rpc**: `<pkg>/rpc`

So a **TUI-only package must not export `.`**, set `main`, or ship a root `server.js`. Otherwise OpenCode treats it as a server plugin too. A package listed in `opencode.json` with no server entry fails with "Plugin entrypoint not found" (`packages/core/src/plugin/module.ts:118`). The ram-monitor smoke script calls `resolve()` directly to assert this **(verified)**.

## Testing TUI plugins with OpenTUI

Register the preload under `[test]` in the package's `bunfig.toml`:

```toml
preload = ["@opentui/solid/preload"]

[test]
preload = ["@opentui/solid/preload"]
```

Importing `@opentui/solid/preload` from a test file runs too late. All imports load before any test body runs, so `solid-js` is already on its server build, and `onMount` / `createEffect` never fire under `testRender` **(verified)**. Tests that only check structure pass anyway; tests that assert polled or effect-driven output will catch it.

Prefer injecting a plugin's I/O dependencies over `mock.module`. Module mocks are process-wide and can leak between test files that run in one `bun test` process.
