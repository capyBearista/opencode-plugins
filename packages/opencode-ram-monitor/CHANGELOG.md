# @capybearista/opencode-ram-monitor

## 2.1.1

### Patch Changes

- a078704: Mark the `@opencode/plugin` peer optional. OpenCode serves `@opencode/plugin/tui` from its own runtime, so installs no longer download an unused copy of the SDK.

## 2.1.0

### Minor Changes

- 4fc0ffa: Rework the RAM monitor for OpenCode 2.x's shared background server. This minor release contains breaking changes; the 2.x line tracks OpenCode V2 rather than strict semver.

  - **Breaking:** TUI-only. The server entry is removed, including the server-side `/ram` that injected the process tree into sessions without a TUI; `/ram` remains in the TUI. List the package only in `cli.json`, and remove any old `opencode.json` entry.
  - **Breaking:** requires OpenCode 2.1+ (`@opencode/plugin >=2.1.0 <3`, OpenTUI `>=0.6.6`).
  - **Breaking:** settings come only from the `cli.json` plugin entry's `options`; the `experimental.ramMonitor` config-file key is no longer read.
  - The sidebar now shows the total plus "OpenCode X · Tools Y" (this TUI + the shared server vs. everything the server runs), replacing the This/All rows and session count that no longer reflect 2.x's process layout. The `/ram` modal shows the TUI, server, and orphaned terminal trees.
  - New `layout: "minimal"` option renders a single borderless row.
  - Invalid options now fall back to defaults with a visible warning (footer text in the full layout, warning color in the minimal layout, and listed in the `/ram` modal) instead of failing silently.

## 2.0.1

### Patch Changes

- 7bdc13d: Support OpenTUI 0.6 SyntaxStyle owner (renderer.nativeScene), backward-compatible with 0.5.

## 2.0.0

### Major Changes

- c224cf0: Publish the opencode-ram-monitor V2 port as 2.0.0 on the `latest` npm tag.

## 1.1.0

### Minor Changes

- d8eb82f: Improve ram-monitor sidebar clarity with a compact card and direct vs with-tools RAM breakdown.

## 1.0.0

### Major Changes

- fc8ad85: Initial v1.0.0 release. RAM Monitor with configuration support, real-time PID discovery, and active session counting.
