# Manual Verification Guide: ocp

This guide covers manual verification of the `ocp` CLI (also available as `oc-plugins` for compatibility).

## 1. Setup

Build both binaries from the package directory:

```bash
# From packages/opencode-plugin-manager
bun run build
# Alias both so you can test both binary names
alias ocp="$(pwd)/target/release/ocp"
alias oc-plugins="$(pwd)/target/release/oc-plugins"
```

Verify both binary names print the expected usage:

```bash
ocp --help
# → CLI tool to manage OpenCode plugins and plugin versions
# → Usage: ocp [OPTIONS] <COMMAND>

oc-plugins --help
# → CLI tool to manage OpenCode plugins and plugin versions
# → Usage: oc-plugins [OPTIONS] <COMMAND>
```

If `ocp --help` shows `oc-plugins` in the usage line, the binary was not rebuilt
after the rename — re-run `bun run build`.

## 2. Test Environment

```bash
mkdir -p /tmp/ocp-test/.opencode
cd /tmp/ocp-test
echo '{"plugin": ["ram-monitor", "@capybearista/opencode-output-styles@0.1.0"]}' > .opencode/opencode.json
```

## 3. Test Cases

### Listing
- `ocp list --project` (Human view, alias resolution)
- `ocp list --project --verbose` (Show config paths)
- `ocp list --project --json` (Machine view)

### Updates
- `ocp outdated --project` (Registry check)
- `ocp outdated --project --refresh` (Force cache refresh)

### Mutations
- `ocp add adversarial-review --project --dry-run` (Preview add)
- `ocp update --project --refresh --dry-run` (Preview exact pinning)
- `ocp update --project --refresh` (Apply exact pinning)
- `ocp remove ram-monitor --project` (Safe removal)

## 4. Compatibility

The `oc-plugins` binary is also installed and accepts all the same flags and
subcommands. Use it if you have scripts or muscle memory that reference the
older name.

## 5. Telemetry

Telemetry is silent and non-blocking. It only sends if `OC_PLUGINS_TELEMETRY_URL` is set.

```bash
# Should be instant and silent
OC_PLUGINS_TELEMETRY_URL=http://localhost:9999 ocp list --project
```

## 6. Expected "Update --refresh" Behavior

When running `update --refresh`:
1. Unpinned plugins (like `ram-monitor`) should be rewritten to `pkg@version`.
2. Pinned plugins (like `pkg@0.1.0`) should be updated to the latest exact version `pkg@0.1.4`.
3. If registry data is missing, pins should **not** be loosened to `@latest`.
