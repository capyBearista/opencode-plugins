# ocp — OpenCode Plugin Manager

A lightning-fast standalone CLI for managing npm-based OpenCode plugins configured in your project or global `opencode.json(c)` files.

> **CLI name:** `ocp` (primary), `oc-plugins` (compatibility alias — both binaries are installed).

## Features

- **Fast local reads** — `list` never touches the network
- **Curated catalog** — CapyBearista plugins get premium display names, descriptions, and aliases
- **Safe mutations** — `add`, `update`, `remove` require confirmation and support `--dry-run`
- **Machine-readable** — stable `--json` output for scripting
- **Cached updates** — startup notices from local cache, no registry fanout on every run

## Commands

| Command | Description |
|---------|-------------|
| `ocp list` | List configured OpenCode plugins |
| `ocp outdated` | Compare configured plugins against npm latest |
| `ocp add <plugin>` | Add a plugin to config |
| `ocp update [plugin]` | Update one or all configured plugins |
| `ocp remove <plugin>` | Remove a plugin from config |

> `oc-plugins` is also available as a compatibility alias. Both binaries accept identical flags and subcommands.

## Global Flags

| Flag | Effect |
|------|--------|
| `--json` | Output structured JSON instead of human text |
| `--quiet` | Suppress non-essential output for `list` and `outdated` |
| `--verbose` | Show config paths for `list` and `outdated`; cache-freshness status for `list` only |

## Command-Specific Flags

| Flag | Commands | Effect |
|------|----------|--------|
| `--project` | all | Scope to project config only |
| `--global` | all | Scope to global config only |
| `--dry-run` | `add`, `update`, `remove` | Preview changes without applying |
| `-y`, `--yes` | `add`, `update`, `remove` | Skip confirmation prompt |
| `--refresh` | `outdated`, `update` | For `outdated`, force refresh of cached registry data; for `update`, fetch npm latest and pin every managed plugin to the exact latest version |

## Usage Examples

### List plugins
```bash
ocp list                    # Human-readable list
ocp list --json             # JSON output for scripting
ocp list --project          # Project plugins only
ocp list --verbose          # Show config paths and cache info
```

### Check for updates
```bash
ocp outdated                # Compare against npm latest
ocp outdated --refresh      # Force fresh registry check
ocp outdated --json         # Machine-readable output
```

### Add a plugin
```bash
ocp add ram-monitor --project          # Add by alias to project config
ocp add @capybearista/opencode-ram-monitor --global  # Add by full name
ocp add ram-monitor --project --dry-run  # Preview without applying
ocp add ram-monitor --project --yes      # Skip confirmation
```

### Update plugins
```bash
ocp update --project                # Update all project plugins
ocp update ram-monitor --global     # Update specific plugin
ocp update --project --dry-run      # Preview updates
ocp update --project --refresh      # Pin all project plugins to exact latest versions
ocp update ram-monitor --global --refresh  # Pin specific plugin to exact latest
```

### Remove a plugin
```bash
ocp remove ram-monitor --project    # Remove by alias
ocp remove ram-monitor --global     # Remove from global config
```

## Output Modes

### Human (default)

```
Configured OpenCode plugins

Project
  RAM Monitor  (ram-monitor)
  Monitor OpenCode's RAM usage per session in real time.
  @capybearista/opencode-ram-monitor
  0.2.1   latest 0.3.0   update available

  Output Styles  (output-styles)
  Persist reusable response styles for OpenCode sessions.
  @capybearista/opencode-output-styles
  0.1.4   latest 0.1.4   current
```

### JSON (`--json`)

The `list` command outputs a flat array:

```json
{
  "plugins": [
    {
      "requestedSpec": "@capybearista/opencode-ram-monitor@latest",
      "packageName": "@capybearista/opencode-ram-monitor",
      "scope": "project",
      "configPath": "/path/to/opencode.json",
      "installed": true,
      "installedVersion": "0.2.1",
      "status": "installed",
      "displayName": "RAM Monitor",
      "description": "Monitor OpenCode's RAM usage per session in real time.",
      "declaredOpenCodeRange": null,
      "latestVersion": "0.3.0",
      "latestDeclaredOpenCodeRange": null
    }
  ]
}
```

The `outdated` command groups plugins by update status. Each entry includes `installStatus` to distinguish "installed but outdated" from "not installed":

```json
{
  "outdated": [
    {
      "packageName": "@capybearista/opencode-ram-monitor",
      "installStatus": "installed",
      "installedVersion": "0.2.1",
      "latestVersion": "0.3.0",
      "status": "outdated"
    }
  ],
  "current": [],
  "unresolved": []
}
```

> **Note:** `--verbose` is ignored in JSON mode. JSON output is always deterministic and complete.

### Quiet (`--quiet`)

Produces no stdout for `list` and `outdated`. Mutation commands still emit preview output.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Updates available (`outdated`), or error occurred |

## JSON Error Format

When `--json` is used and an error occurs, the error is serialized as:

```json
{
  "error": "NOT_FOUND",
  "message": "Plugin 'unknown-plugin' is not configured"
}
```

Error types: `CONFIG_ERROR`, `IO_ERROR`, `PARSE_ERROR`, `NETWORK_ERROR`, `NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

## Aliases

CapyBearista plugins support short aliases for write commands:

| Alias | Package |
|-------|---------|
| `ram-monitor` | `@capybearista/opencode-ram-monitor` |
| `output-styles` | `@capybearista/opencode-output-styles` |
| `agents-loader` | `@capybearista/opencode-agents-loader` |
| `adversarial-review` | `@capybearista/opencode-adversarial-review` |
| `agent-prompt-inheritance` | `@capybearista/opencode-agent-prompt-inheritance` |
| `double-tap-timeline` | `@capybearista/opencode-double-tap-timeline` |

Aliases work in `add`, `update`, and `remove`. Human output shows the short alias in parentheses. JSON output always exposes the canonical package name only (no `alias` field).

## Development

This is a Rust package within the OpenCode monorepo.

```bash
# From package directory
cargo run -- list
cargo test

# From monorepo root
bun --filter @capybearista/opencode-plugin-manager build
bun --filter @capybearista/opencode-plugin-manager test
```

### Pre-PR Checklist

```bash
bun --filter @capybearista/opencode-plugin-manager typecheck && \
bun --filter @capybearista/opencode-plugin-manager check && \
bun --filter @capybearista/opencode-plugin-manager test && \
bun --filter @capybearista/opencode-plugin-manager build
```

## Telemetry

`ocp` collects minimal, privacy-light operational telemetry to help
improve the tool. **No identity, file path, project path, location, IP-derived
data, or machine fingerprint is collected.**

### What is collected

Per command: command name, success/failure, duration bucket (`fast`,
`moderate`, `slow`, `very_slow`), and tool version.

### Opt-out

Telemetry is disabled automatically when any of these are set to a non-empty
value:

- `DISABLE_TELEMETRY`
- `DO_NOT_TRACK`
- `CI`

Telemetry is also suppressed in `--json` and `--quiet` modes to preserve
script discipline.

### Endpoint

Telemetry is sent via an HTTP POST with a short timeout to the URL configured
in the `OC_PLUGINS_TELEMETRY_URL` environment variable. If this variable is
unset or empty, no data is sent.

## License

MPL-2.0
