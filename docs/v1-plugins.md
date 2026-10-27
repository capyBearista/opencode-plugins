# V1 plugins: install, pin, and compatibility

For anyone running these plugins on OpenCode V1.

The package READMEs for `opencode-agents-loader`, `opencode-double-tap-timeline`, `opencode-ram-monitor`, `opencode-adversarial-review`, and `opencode-output-styles` describe their published V2 releases. This guide retains setup instructions for the frozen V1 versions.

## Status

| Package | V1 version shown here | Release policy |
| --- | --- | --- |
| `opencode-agents-loader` | 1.0.0, frozen | V2 `2.x` is on `latest`. No further 1.x from this line. |
| `opencode-double-tap-timeline` | 1.0.1, frozen | V2 `2.x` is on `latest`. No further 1.x from this line. |
| `opencode-adversarial-review` | 1.0.0 | V1 `latest` is superseded: V2 `2.x` uses `latest`. Pin `1.0.0` for OpenCode V1. |
| `opencode-agent-prompt-inheritance` | `latest` | Active V1 releases use `latest`; upstream prompt sync remains enabled. No V2 release yet; a V2 port is TBD. |
| `opencode-output-styles` | 1.0.2, frozen | V2 `2.x` is on `latest`. Pin `@1` for OpenCode V1. No further 1.x from this line. |
| `opencode-ram-monitor` | 1.1.0 | V1 `latest` is superseded: V2 `2.x` uses `latest`. Pin `1.1.0` for OpenCode V1. |

The loader and timeline V1 releases are frozen and remain available by exact pin. Their `latest` tags now point at V2 `2.x`, as do `opencode-adversarial-review`, `opencode-ram-monitor`, and `opencode-output-styles`.

## Requirements

Use OpenCode V1. These releases use the `@opencode-ai/plugin` SDK; consult the installed package version's manifest for its exact peer range. An SDK peer range does not pin the OpenCode binary or select a registry channel.

The current V1 releases (`opencode-agent-prompt-inheritance` 1.0.1+, `opencode-output-styles` 1.0.2) declare `@opencode-ai/plugin` `>=1.19.3 <2`. On an older 1.x SDK, pin `opencode-agent-prompt-inheritance@1.0.0` or `opencode-output-styles@1.0.1`, which declare `>=1.15.3`.

## Install

Server plugins go in `opencode.json` / `opencode.jsonc` under the `"plugin"` key. TUI plugins go in `tui.json` / `tui.jsonc` under the same `"plugin"` key. `opencode-ram-monitor` is both, so register it in each file. The keys are singular in V1; V2 uses a different key (see below).

```json
{
  "plugin": ["@capybearista/opencode-agent-prompt-inheritance@latest"]
}
```

Through the V1 CLI:

```bash
opencode plugin @capybearista/opencode-agent-prompt-inheritance@latest
```

For the frozen loader, use `@capybearista/opencode-agents-loader@1.0.0` in the V1 server config. For the frozen timeline, use `@capybearista/opencode-double-tap-timeline@1.0.1` in the V1 TUI config. For the frozen output-styles, use `@capybearista/opencode-output-styles@1` in the V1 server config. The V1-only `opencode-agent-prompt-inheritance` README retains its V1 usage instructions; see the root [README](../README.md) for every package and its V1 pin.

## Pinning and updates

Pin an exact version for a fixed setup. For every package except `opencode-agent-prompt-inheritance`, `@latest` is V2 `2.x`; on OpenCode V1, pin the versions in the table above (or `@1` for output-styles). For `opencode-agent-prompt-inheritance`, `@latest` selects the current V1 release when first resolved. Bare names and `@latest` normalize to the same V1 target; switching between them is not an upgrade.

Restarting OpenCode does not fetch a newer release for an already cached target. To move an actively maintained V1 plugin to another release, stop active sessions, select a different exact version, and use `opencode plugin --force <package>@<version>` to replace the configured entry. `--force` does not refresh cached files for the same `@latest` specifier. Loader, timeline, and output-styles have no further V1 releases planned. Do not delete cache directories or plugin-managed files as routine update maintenance.

## V2 boundary

The five V2 ports use the plural `"plugins"` key: loader, adversarial-review, and output-styles (server + TUI, one entry; needs OpenCode 2.2.0+; its TUI half loads automatically) belong in server `opencode.json`; timeline and ram-monitor belong in TUI `cli.json` (ram-monitor was a dual server+TUI plugin through `2.0.x` and is TUI-only from `2.1.0`). Local directory loading uses `server.js` and `tui.js`, respectively. All five are published as `2.x` on `latest`.

Keep the lines apart: V1 and V2 may share a default configuration directory, and these plugin releases do not migrate it for you. Use separate profiles for side-by-side testing. V2 provides explicit plugin `check` and `update` actions; a restart or reload alone does not upgrade a cached target, and exact pins stay fixed.
