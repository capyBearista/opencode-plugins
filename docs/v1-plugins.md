# V1 plugins: install, pin, and compatibility

For anyone running these plugins on an OpenCode V1 host.

The package READMEs for `opencode-agents-loader` and `opencode-double-tap-timeline` describe their published V2 releases. This guide retains setup instructions for the frozen V1 versions.

## Status

| Package | V1 version shown here | Release policy |
| --- | --- | --- |
| `opencode-agents-loader` | 1.0.0, frozen | V2 2.0.0 uses `opencode2`. No further 1.x from this line. |
| `opencode-double-tap-timeline` | 1.0.1, frozen | V2 2.0.0 uses `opencode2`. No further 1.x from this line. |
| `opencode-adversarial-review` | 1.0.0 | Active V1 releases use `latest`. |
| `opencode-agent-prompt-inheritance` | 1.0.0 | Active V1 releases use `latest`; upstream prompt sync remains enabled. No V2 port. |
| `opencode-output-styles` | 1.0.1 | Active V1 releases use `latest`. |
| `opencode-ram-monitor` | 1.1.0 | Active V1 releases use `latest`. No V2 port in this release. |

The loader and timeline `latest` tags remain frozen after V2 publication too. This freeze does not apply to the other four packages.

## Requirements

Use an OpenCode V1 host. These releases use the `@opencode-ai/plugin` SDK; consult the installed package version's manifest for its exact peer range. An SDK peer range does not pin the OpenCode binary or select a registry channel.

## Install

Server plugins go in `opencode.json` / `opencode.jsonc` under the `"plugin"` key. TUI plugins go in `tui.json` / `tui.jsonc` under the same `"plugin"` key. `opencode-ram-monitor` is both, so register it in each file. The keys are singular in V1; V2 uses a different key (see below).

```json
{
  "plugin": ["@capybearista/opencode-output-styles@latest"]
}
```

Through the V1 CLI:

```bash
opencode plugin @capybearista/opencode-output-styles@latest
```

For the frozen loader, use `@capybearista/opencode-agents-loader@1.0.0` in the V1 server config. For the frozen timeline, use `@capybearista/opencode-double-tap-timeline@1.0.1` in the V1 TUI config. The other four package READMEs retain their V1 usage instructions; see the root [README](../README.md) for links.

## Pinning and updates

Pin an exact version for a fixed setup. For loader and timeline, `@latest` remains at the frozen versions above. For the other packages, it selects the current V1 release when first resolved. Bare names and `@latest` normalize to the same V1 target; switching between them is not an upgrade.

Restarting OpenCode does not fetch a newer release for an already cached target. To move an actively maintained V1 plugin to another release, stop active sessions, select a different exact version, and use `opencode plugin --force <package>@<version>` to replace the configured entry. `--force` does not refresh cached files for the same `@latest` specifier. Loader and timeline have no further V1 releases planned. Do not delete cache directories or plugin-managed files as routine update maintenance.

## V2 boundary

The two V2 ports use the plural `"plugins"` key: loader belongs in server `opencode.json`, while timeline belongs in TUI `cli.json`. Local directory loading uses `server.js` and `tui.js`, respectively. Both `2.0.0` releases are published under the `opencode2` tag.

Keep the lines apart: V1 and V2 may share a default configuration directory, and these plugin releases do not migrate it for you. Use separate profiles for side-by-side testing. V2 provides explicit plugin `check` and `update` actions; a restart alone does not upgrade a cached target, and exact pins stay fixed.
