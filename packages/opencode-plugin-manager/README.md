# oc-plugins

A lightning-fast standalone CLI for managing npm-based OpenCode plugins configured in your project or global `opencode.json(c)` files.

## Features

- **Fast local reads** — `list` never touches the network
- **Curated catalog** — CapyBearista plugins get premium display names, descriptions, and aliases
- **Safe mutations** — `add`, `update`, `remove` require confirmation and support `--dry-run`
- **Machine-readable** — stable `--json` output for scripting
- **Cached updates** — startup notices from local cache, no registry fanout on every run

## Commands

| Command | Description |
|---------|-------------|
| `oc-plugins list` | List configured OpenCode plugins |
| `oc-plugins outdated` | Compare configured plugins against npm latest |
| `oc-plugins add <plugin>` | Add a plugin to config |
| `oc-plugins update [plugin]` | Update one or all configured plugins |
| `oc-plugins remove <plugin>` | Remove a plugin from config |

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
| `--refresh` | `outdated` | Force refresh of cached registry data |

## Usage Examples

### List plugins
```bash
oc-plugins list                    # Human-readable list
oc-plugins list --json             # JSON output for scripting
oc-plugins list --project          # Project plugins only
oc-plugins list --verbose          # Show config paths and cache info
```

### Check for updates
```bash
oc-plugins outdated                # Compare against npm latest
oc-plugins outdated --refresh      # Force fresh registry check
oc-plugins outdated --json         # Machine-readable output
```

### Add a plugin
```bash
oc-plugins add ram-monitor --project          # Add by alias to project config
oc-plugins add @capybearista/opencode-ram-monitor --global  # Add by full name
oc-plugins add ram-monitor --project --dry-run  # Preview without applying
oc-plugins add ram-monitor --project --yes      # Skip confirmation
```

### Update plugins
```bash
oc-plugins update --project                # Update all project plugins
oc-plugins update ram-monitor --global     # Update specific plugin
oc-plugins update --project --dry-run      # Preview updates
```

### Remove a plugin
```bash
oc-plugins remove ram-monitor --project    # Remove by alias
oc-plugins remove ram-monitor --global     # Remove from global config
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

## License

MPL-2.0
