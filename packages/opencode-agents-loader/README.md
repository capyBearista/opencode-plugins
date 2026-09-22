# opencode-agents-loader

<p align="center">Extend V2 agent and command discovery to the .agents/ directory standard</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-agents-loader"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-agents-loader?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Release status

Version **2.0.0** is published on the **`opencode2`** channel for OpenCode V2.
The V1 `latest` release remains frozen at **1.0.0**. Do not install the V2 package in a V1 host.

See the [V1 plugin guide](../../docs/v1-plugins.md) for the frozen V1 setup and the
[documentation index](../../docs/README.md) for repository-wide scope notes.

## V2-only

This package targets the V2 Promise plugin API (`@opencode/plugin` **2.0.2**). That is the host API
dependency, separate from this plugin's package version. It exports a default
`Plugin.define({ id, setup })` definition and is not compatible with the V1 `server`/`config` hook
shape. Install it in an OpenCode V2 host; use the frozen V1 package for a V1 host.

## Why?

> The `.agents/` directory is becoming an open standard for agent-based tools. This plugin lets OpenCode read commands and agents from `~/.agents/` and `.agents/` directories, enabling interoperability with other harnesses and cleaner project organization.

## Philosophy: Extending OpenCode

OpenCode natively reads from `.opencode/` and configuration files. During awaited setup this plugin
creates managed relative symlinks from `.agents/` command and agent files into the matching native
directories. Native OpenCode therefore owns frontmatter decoding, V1 migration, argument
expansion, shell interpolation, subagent execution, agent permissions, and precedence. The plugin
does not register an agent or command transform and does not copy prompt bodies.

### Architecture

```text
src/index.ts
    └── V2 setup
        ├── awaits the scoped command symlink bridge
        └── awaits the scoped agent symlink bridge

command-bridge.ts
    ├── materializes per-scope native command and agent links
    ├── records exact ownership in separate manifests and locks
    └── polls bounded censuses and emits the affected host reload signal

agent-source.ts
    └── validates V1/V2 agent frontmatter before an agent link is created
```

## Features

- Discovers command and agent markdown files from `~/.agents/` and `.agents/` directories
- Supports `command/`, `commands/`, `agent/`, and `agents/` source subdirectory naming
- Materializes managed relative symlinks so native OpenCode owns parsing and execution
- Respects existing native files and explicit config entries — plugin entries never overwrite native config
- Scans scopes between the declared project root and the current working directory, not above the root
- YAML frontmatter support for metadata in markdown files
- Preserves V2 model references, system bodies, agent modes, and ordered permission rules
- Automatically starts both native bridges; no manual sync step is required
- Preserves complete command and agent source bytes and nested relative names by symlink, including
  shell and subagent templates
- Uses `OPENCODE_CONFIG_DIR` for the global native destination; global sources remain in `~/.agents/`

## Install

Use `@opencode2` or the exact `@2.0.0` version for V2. `@latest` identifies the frozen V1
line, and `@v2` is a semver range rather than a channel. The local recipe below is for
development in an isolated V2 profile.

### Local V2 directory

Build before checking a local directory or a packaged artifact. From this package directory, run
`bun run build`; from the monorepo root, the canonical command is `bun run build`. Then register the
package **directory**, not a JavaScript file:

Add the directory to your isolated V2 server profile's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-plugins/packages/opencode-agents-loader"]
}
```

A filesystem directory target is resolved through its root `server.js`,
not through the package's `exports` map, and the wrapper intentionally exposes no TUI or RPC entrypoint.
The package-name import still uses the unchanged `exports` map, including the default and named exports
from `dist/index.js`. Because the wrapper imports that built file, a build is required before using a
filesystem-local package root. Do not configure `server.js` or `dist/index.js` directly; use the
directory so the host can apply its local-entrypoint rules.

### Registry installation

The V2 server profile `~/.config/opencode/opencode.json` may contain the loader under
the plural `plugins` key:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@capybearista/opencode-agents-loader@opencode2"]
}
```

Use `@2.0.0` instead of `@opencode2` for an exact pin. The V2 command definitions are separate
from the V1 CLI:

```bash
opencode2 plugin add @capybearista/opencode-agents-loader@opencode2
opencode2 plugin check
```

`check` reports available updates without installing them. Use `opencode2 plugin update` with the
configured target as its argument to update that package; omitting the target updates all configured
mutable targets. Restarting the host does not upgrade a package, and exact pins remain fixed.
The `opencode2` tag identifies OpenCode 2 compatibility, not the plugin's package major: later
package majors can use the same channel.

Keep this V2 profile separate from V1 configuration. Both hosts may use the default
`~/.config/opencode/` directory. `OPENCODE_CONFIG_DIR` selects a separate configuration root;
isolating session data and caches requires separate data, state, cache, and home locations too.
The plugin does not migrate configuration or session data.

For the frozen V1 package, use a V1 host and the V1 command `opencode plugin <module>` with an
explicit `@1.0.0` spec. V1 reuses cached installations; restarting alone is not an update. Do not
use the V2 `plugin add`, `check`, or `update` commands for that host.

## Usage

Create markdown files with YAML frontmatter:

```md
---
description: "Does something useful"
---

# Command Body
This is the command content that the agent will process.
```

### Commands

Place command markdown files in `command/` or `commands/` subdirectories:

```text
~/.agents/
  commands/
    hello.md
    git/
      status.md

.agents/
  commands/
    project-specific-prompt.md
```

### Agents

Place agent markdown files in `agent/` or `agents/` subdirectories:

```text
~/.agents/
  agents/
    reviewer.md
    architect.md

.agents/
  agents/
    project-expert.md
```

Only `agent/` and `agents/` are plugin source directories. `mode/` and `modes/` remain native
OpenCode aliases and are not treated as new plugin agent sources; a native mode with the same name
still reserves that name. A source agent's declared `mode` is preserved, including `subagent`; the
bridge never infers or forces `primary`.

### Native bridges, precedence, and ownership

Setup walks lexical ancestor scopes from the project root to the current working directory. The
initial command and agent syncs are awaited before setup returns so native OpenCode startup
discovery can see the links. Each scope maps both `.agents/command/` and `.agents/commands/` into
that **same** scope's `.opencode/commands/` directory, and both `.agents/agent/` and
`.agents/agents/` into that scope's `.opencode/agents/` directory. Global files map from
`~/.agents/{command,commands}` and `~/.agents/{agent,agents}` into the corresponding
`$OPENCODE_CONFIG_DIR` directories, or `~/.config/opencode/` when the variable is absent. Original
source files and OpenCode config files are never rewritten.
Startup may create native command and agent directories, managed symlinks, and manifest metadata; importing
the module alone performs no filesystem writes.

OpenCode resolves scope first. At a given scope, native command and agent files, native aliases,
and explicit JSON/JSONC config names reserve a name before the bridge creates a link. A nearer
project `.agents/` scope is materialized in its own nearer `.opencode/` directory and therefore
remains nearer than an ancestor scope; every eligible scope keeps its own links. The bridge does
not delete an ancestor artifact merely because a nearer scope has the same name. Global files map
from `~/.agents/` to the global native root, while native JSON/JSONC and `OPENCODE_CONFIG*`
ordering remain OpenCode's authority. The bridge reserves names at a scope; it does not promise to
reorder native sources.

If both `.agents/command/name.md` and `.agents/commands/name.md` exist at one scope, the plural
`commands/` spelling wins deterministically. Nested names remain nested (`review/code.md` stays
`review/code.md`); this is the native command naming behavior and may differ from old V1
flattening.

Each destination parent has version-1, domain-specific ownership metadata at `.agents-loader/`.
Commands use `commands-manifest.json` and `commands.lock`; agents use `agents-manifest.json` and
`agents.lock`. For a project destination these live under `.opencode/.agents-loader/`; for the
global destination they live under `$OPENCODE_CONFIG_DIR/.agents-loader/`. Entries record the
relative destination, source path, and literal `readlink` payload. Only an exact recorded symlink
can be removed. Regular files, directories, unowned symlinks, alias collisions, malformed
manifests, traversal, and parent-symlink escapes fail closed with diagnostics; consecutive duplicate
messages are suppressed. Neither bridge adopts or removes the other domain's artifacts.

Manifest writes are atomic. Cooperating instances use a bounded per-domain lock and never
guess-delete a stale lock. A pre-existing or crash-held lock fails closed without changing that
scope. Lock diagnostics include the exact lock path; manually remove that exact
`commands.lock` or `agents.lock` only after all affected OpenCode instances are stopped, then
retry. An uncooperative process can still win a filesystem TOCTOU race between validation and
`symlink`/`unlink`; the bridge does not claim to eliminate that operating-system limitation.

Each bridge polls at a modest fixed interval (500 ms by default). Source sync detects source edits
even when a symlink is unchanged; creation, deletion, rename, invalid-source removal, and
native-name reservation changes reconcile and may emit the affected `ctx.command.reload()` or
`ctx.agent.reload()` once per observed change. A reload signal is not itself a native rescan: a
host watcher must rescan the materialized links, or restart OpenCode as the fallback. Whether an
initially missing native config directory is picked up by the host's startup scan is a human
verification gate. Dispose clears each timer. In the observed V2 check, new definitions appeared
without a restart, description changes took effect after a restart, and removal cleanup succeeded.
No deletion-latency or universal hot-reload guarantee is made.

### Limitations

- Command execution is intentionally not emulated by this package. Native OpenCode owns `$ARGUMENTS`,
  `$N`, the exclamation/backtick shell syntax, and `subagent` behavior; live execution checks remain
  a human responsibility.
- Any source file or directory symlink under the active `.agents/{command,commands,agent,agents}`
  sources makes the affected bridge's census at that scope unsafe. That bridge emits a diagnostic
  and preserves its last known managed links rather than reconciling an incomplete census.
- Destination directories must be writable and support symlink creation. There is no copy fallback.
- JSON/JSONC inspection is limited to same-scope name reservation. OpenCode remains the parser and
  ordering authority; the bridge never normalizes or rewrites those files.
- A current working directory outside the declared project root is rejected safely; the bridge does
  not silently fall back to writing the project root or broaden discovery to `/`.
- Invalid/unsupported agent metadata, including malformed permission rules, is skipped rather than silently
  falling back to broader tool access. V2 `request` accepts only `headers` and `body`; `settings` and
  allowed-tools-like unknown permission aliases are rejected with a diagnostic. Mixing legacy
  `tools`/`permission` fields with V2 `permissions` is rejected clearly rather than merged. Legacy
  `disable`, `options`, `temperature`, and model variants are validated using the native V1 migration shape.
  If an existing source becomes invalid, its owned link can be removed; native catalog changes still
  require a host rescan or restart.
- Agent prompts and frontmatter bytes are never copied or rewritten; the native loader follows the managed
  symlink and owns V1/V2 decoding. This package does not implement prompt inheritance or an agent transform;
  there is no V2 inheritance feature.

## Configuration

There are no plugin-specific settings. After registering the plugin in the V2 server profile, it
reads the documented `.agents/` directories automatically. Keep the V2 profile separate from any
V1 configuration as described in [Install](#install).

## Troubleshooting

- If commands or agents don't appear, verify your files end in `.md` and include valid YAML frontmatter
- Confirm the directory naming is `commands/` or `command/`, `agents/` or `agent/`
- Inspect the scoped `.agents-loader/{commands,agents}-manifest.json` and diagnostics before removing
  anything; unowned native files are intentionally preserved

## Verification notes

The package checks include the real local-directory resolver regression, build/static checks, and
the scoped bridge tests. In one isolated V2 host, human verification confirmed agent and command
discovery and native execution, global/project precedence fixtures, live additions, restart-required
description changes, and removal cleanup. These observations do not promise identical watcher
behavior for every host, platform, provider, or config layout.

## Contributing

This package lives in the `opencode-plugins` monorepo.

See the [contribution guidelines](../../CONTRIBUTING.md) before opening a pull request.

- From the monorepo root, run `bun run build` before artifact checks, then `bun run typecheck`,
  `bun run lint`, and the canonical `bun run test` Turbo pipeline. Do not use bare root `bun test`
  as the workspace check.
- For a focused run, `bun test` is supported from this package directory; its tests include the
  real local-directory resolver regression.
- `bun run check` writes Biome changes; use it only when formatting changes are intended.
- Keep the plugin focused on agent/command discovery from `.agents/` directories.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](./LICENSE.txt)
