# @capybearista/opencode-adversarial-review

## 2.0.2

### Patch Changes

- 9bd58a9: Create the `commands/` directory on setup when it is missing. Before, a config directory without `commands/` made setup fail and neither reviewer agent was registered.

## 2.0.1

### Patch Changes

- a20269b: Accept `@opencode/plugin` `>=2.0.2 <3` instead of exactly `2.0.2`, so OpenCode 2.1+ installs no longer warn about an unmet peer and the range stops at V3.

## 2.0.0

### Major Changes

- 914f49f: V2 port: agent-in-plugin re-orientation, a second constructive reviewer, and version-stamped command installs.

## 1.0.0

### Major Changes

- 65e9779: bump to v1.0.0

## 0.1.0

### Minor Changes

- cb28b09: Initial release of the adversarial code review plugin. Adds the `/adversarial-review` command and specialized subagent for zero-trust code auditing.
