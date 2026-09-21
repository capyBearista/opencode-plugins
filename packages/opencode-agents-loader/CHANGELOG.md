# @capybearista/opencode-agents-loader

## 2.0.0

### Major Changes

- Switch this package to the OpenCode V2 host SDK. This is a breaking V2-only release and does not change the frozen V1 `latest` line.

  The loader bridges native agent and command discovery from scoped `.agents/` directories. It keeps the source hierarchy, preserves native host ownership, records managed links separately, and requests the affected host reload when sources change. Description changes require a host rescan or an OpenCode restart when the host does not rescan. The package root includes `server.js` as the filesystem-local V2 plugin entry.

  V2 releases use the opt-in `opencode2` channel. The V1 `latest` line remains frozen at 1.0.0.
