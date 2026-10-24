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
- **`context.client` talks to the server this TUI uses.** `client.server.info()` returns `{ version, pid, urls, paths, capabilities }`, where `pid` is the server's own process ID, so a plugin can find the server it is connected to **(verified, standalone and shared service)**. It is available from `@opencode/client` 2.1.0; the 2.0.2 client has `client.health.get()` instead, which also returns `pid`. Under `--server`, that `pid` may belong to another machine, so check it against the local process table before trusting it.
- **`context.client` is captured once.** The context stores `host.client.api` when the plugin activates (`packages/tui/src/plugin/api.tsx:159`). It is not a getter, and plugins are not re-activated when the TUI reconnects. In practice it keeps working across `opencode service restart`, because the default service keeps a fixed port and a password persisted in `<config>/service.json` **(verified)**. A changed port or password would leave it stale **(source)**.
- **The host serves the SDK.** A bare `import … from "@opencode/plugin/tui"` resolves to the host's built-in module on every 2.x, never to the plugin's installed copy; the loader only duck-types `{ id, setup }` (`packages/tui/src/plugin/runtime-plugin-support.bun.ts:5-11`, `packages/tui/src/plugin/context.tsx:741-751`). TUI plugins can therefore mark the `@opencode/plugin` peer optional so installs skip an unused ~180 MB tree **(verified on 2.0.0, 2.0.24, 2.1.4)**. Server plugins cannot: the server only serves `@opencode/plugin` from 2.0.25 (`packages/plugin/src/runtime.ts:12-34`), and before that a server plugin without its own copy fails with `Cannot find package '@opencode/plugin'` **(verified on 2.0.0, 2.0.24)**. Import by bare specifier only; a deep file import bypasses the host module.
- **`context.options`** is the `options` object of the plugin's `cli.json` entry, or `{}` (`packages/tui/src/plugin/api.tsx:153`). Plugins loaded only from the server's inventory get no options (`packages/tui/src/plugin/context.tsx:301-305`).
- **`setup` is awaited** before the plugin is active (`packages/tui/src/plugin/context.tsx:639-641`). Register slots synchronously and do I/O inside components (see the [IPC guide](./opencode-plugin-ipc-and-os-patterns.md)).

## Config and options

- TUI plugins are listed in the global `cli.json` only. There is no project-level `cli.json` **(source: `services/www/src/docs/content/cli/config.mdx`)**.
- A `plugins` entry is a string or `{ "package": "...", "options": { ... } }` (`packages/tui/src/config/index.tsx:47-55`).
- **A V1 tuple entry voids the whole file.** `cli.json` is decoded all-or-nothing (`packages/cli/src/config/config.ts:22, 65`). One `["pkg", { ... }]` entry makes OpenCode ignore the file entirely: theme, keybinds, and every plugin **(verified: a probe plugin listed next to a tuple never loaded)**. Document the object form in every README that shows options.
- **Editing options re-activates the plugin live.** The host compares options between generations (`packages/tui/src/plugin/context.tsx:726-735`) and re-runs `setup` with the new values, so a plugin needs no config-file watcher **(verified)**.

## Entry resolution

`Host.resolve` (`packages/plugin/src/host.ts:17-43`, exported as `@opencode/plugin/host`) looks for:

- **server**: `<pkg>/server`, then the package root (`<pkg>`, or `index` for a local directory)
- **tui**: `<pkg>/tui`
- **rpc**: `<pkg>/rpc`

What counts as a server entry depends on how the plugin is loaded:

- **Named package** (npm): resolution goes through the package's `exports` map. A TUI-only package must not export `.` or `./server`. Without an `exports` map, `main` would count as the root.
- **Local directory** (a path in `cli.json`): resolution looks at files. A TUI-only package must not ship a root `server.js` or `index.js`.

Otherwise OpenCode treats it as a server plugin too. A TUI-only package does nothing from `opencode.json`; list it in `cli.json`. The ram-monitor smoke script calls `resolve()` with the package directory, so it asserts the local-directory case **(verified)**.

## Combined server + TUI packages

Learned while porting `opencode-output-styles`; details and evidence in [output-styles/v2-port-findings.md](./output-styles/v2-port-findings.md).

- **One `opencode.json` entry loads both halves.** The TUI loads the `./tui` entry of any active server plugin that reports `features.tui` **(verified on 2.0.23, 2.1.4)**. That TUI half gets `context.options = {}`, so hand server options over with an RPC (`ctx.rpc.register` on the server, `context.client.rpc(Def)` in the TUI). Every RPC call needs an object input; a missing one fails with `rpc.invalid_input` **(verified)**.
- **The SDK peer stays required.** The server half needs its own `@opencode/plugin` copy before 2.0.25 (see above) **(verified on 2.0.23)**.
- **Session metadata is replace-only and inherited.** `session.update({ metadata })` replaces the whole object, and subagent sessions inherit it, so merge before writing and check `parentID` **(verified)**.
- **`session.hook("context")` runs last and on every agent request**, including the step after a tool call, after the built-in `identity` and `optimize` hooks **(verified)**.
- **TUI session data does not react to metadata changes.** Feed a signal from `data.on("session.metadata.updated")` **(verified)**. A slot element with `onMouseUp → context.keymap.dispatch("<command id>")` runs the plugin's own command, which is how the TUI's own footer works **(verified)**.

## Testing TUI plugins with OpenTUI

Register the preload under `[test]` in the package's `bunfig.toml`:

```toml
preload = ["@opentui/solid/preload"]

[test]
preload = ["@opentui/solid/preload"]
```

Importing `@opentui/solid/preload` from a test file runs too late. All imports load before any test body runs, so `solid-js` is already on its server build, and `onMount` / `createEffect` never fire under `testRender` **(verified)**. Tests that only check structure pass anyway; tests that assert polled or effect-driven output will catch it.

Prefer injecting a plugin's I/O dependencies over `mock.module`. Module mocks are process-wide and can leak between test files that run in one `bun test` process.
