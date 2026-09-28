# V1 plugins: install, pin, and compatibility

For anyone running these plugins on OpenCode V1.

The package READMEs for `opencode-agents-loader`, `opencode-double-tap-timeline`, `opencode-ram-monitor`, and `opencode-adversarial-review` describe their published V2 releases. This guide retains setup instructions for the frozen V1 versions.

## Status

| Package | V1 version shown here | Release policy |
| --- | --- | --- |
| `opencode-agents-loader` | 1.0.0, frozen | V2 `2.0.0` is on `latest`. No further 1.x from this line. |
| `opencode-double-tap-timeline` | 1.0.1, frozen | V2 `2.0.0` is on `latest`. No further 1.x from this line. |
| `opencode-adversarial-review` | 1.0.0 | V1 `latest` is superseded: V2 `2.0.0` uses `latest`. Pin `1.0.0` for OpenCode V1. |
| `opencode-agent-prompt-inheritance` | 1.0.0 | Active V1 releases use `latest`; upstream prompt sync remains enabled. No V2 release yet; a V2 port is TBD. |
| `opencode-output-styles` | 1.0.1 | Active V1 releases use `latest`. Deprecated for V2; no V2 maintenance planned. |
| `opencode-ram-monitor` | 1.1.0 | V1 `latest` is superseded: V2 `2.0.0` uses `latest`. Pin `1.1.0` for OpenCode V1. |

The loader and timeline V1 releases are frozen and remain available by exact pin. Their `latest` tags now point at V2 `2.0.0`, as do `opencode-adversarial-review` and `opencode-ram-monitor`.

## Requirements

Use OpenCode V1. These releases use the `@opencode-ai/plugin` SDK; consult the installed package version's manifest for its exact peer range. An SDK peer range does not pin the OpenCode binary or select a registry channel.

## Install

Server plugins go in `opencode.json` / `opencode.jsonc` under the `"plugin"` key. TUI plugins go in `tui.json` / `tui.jsonc` under the same `"plugin"` key. `opencode-ram-monitor` is both, so register it in each file. The keys are singular in V1; V2 uses a different key (see below).

```json
{
  "plugin": ["@capybearista/opencode-output-styles@1.0.1"]
}
```

Through the V1 CLI:

```bash
opencode plugin @capybearista/opencode-output-styles@1.0.1
```

For the frozen loader, use `@capybearista/opencode-agents-loader@1.0.0` in the V1 server config. For the frozen timeline, use `@capybearista/opencode-double-tap-timeline@1.0.1` in the V1 TUI config. The two V1-only package READMEs (`opencode-agent-prompt-inheritance`, `opencode-output-styles`) retain their V1 usage instructions; see the root [README](../README.md) for every package and its V1 pin.

## Pinning and updates

Pin an exact version for a fixed setup. For loader and timeline, `@latest` is V2 `2.0.0`; pin the exact V1 versions above for OpenCode V1. For the other packages, it selects the current V1 release when first resolved. Bare names and `@latest` normalize to the same V1 target; switching between them is not an upgrade.

Restarting OpenCode does not fetch a newer release for an already cached target. To move an actively maintained V1 plugin to another release, stop active sessions, select a different exact version, and use `opencode plugin --force <package>@<version>` to replace the configured entry. `--force` does not refresh cached files for the same `@latest` specifier. Loader and timeline have no further V1 releases planned. Do not delete cache directories or plugin-managed files as routine update maintenance.

## V2 boundary

The four V2 ports use the plural `"plugins"` key: loader and adversarial-review belong in server `opencode.json`, timeline belongs in TUI `cli.json`, and ram-monitor is a dual plugin (server `opencode.json` plus TUI `cli.json`). Local directory loading uses `server.js` and `tui.js`, respectively. All four are published as `2.0.0` on `latest`.

Keep the lines apart: V1 and V2 may share a default configuration directory, and these plugin releases do not migrate it for you. Use separate profiles for side-by-side testing. V2 provides explicit plugin `check` and `update` actions; a restart or reload alone does not upgrade a cached target, and exact pins stay fixed.
