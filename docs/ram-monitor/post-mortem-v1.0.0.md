# `opencode-ram-monitor` v1.0.0 Post-Mortem

This document summarizes the architectural challenges and bug fixes encountered during the stabilization and v1.0.0 preparation of the `@capybearista/opencode-ram-monitor` plugin.

## 1. IPC Boot Deadlock
**The Issue:** The initial plugin implementation attempted to perform a top-level `await` to read configuration before registering the TUI slots (`tui: TuiPlugin = async (api) => { await config(); api.slots.register(...) }`). Because the OpenCode host boots synchronously and awaits the module export, this blocked the IPC channel and caused the UI to hang on a black screen.
**The Fix:** Deferred configuration loading to SolidJS's `onMount` hook inside the Solid component (`sidebar.tsx`). The plugin factory now registers its slots immediately, and the widget loads the config and starts polling asynchronously after mounting.

## 2. Strict Host Schema Stripping
**The Issue:** We attempted to read our configuration (`experimental.ramMonitor.refreshIntervalMs`) using `api.client.config.get()`. However, the host uses strict Zod schema validation for its config object and silently strips any unknown "experimental" keys.
**The Fix:** Bypassed the API client entirely for custom plugin config. The widget now uses `node:fs/promises` to manually read `.opencode/opencode.json` from disk using the resolved worktree path (`api.state.path.worktree`).

## 3. Active Session Discovery (Tokenization Bugs)
**The Issue:** Originally, active session discovery used stale `.lock` files or naive substring matching on command lines. If a user had `node_modules/.bin/opencode` running or a similarly named directory, false positives occurred.
**The Fix:** Built a robust token classifier (`classifyOpencodeProcess` in `memory.ts`). It explicitly strips quotes, splits command line arguments, handles `node` and `bun` executable wrappers, skips standard Node flags (`-r`, `--eval`), and correctly identifies whether the active script is `opencode` (launcher) or `.opencode` (core process).

## 4. Windows Commas & CSV Parser Failure
**The Issue:** Windows process querying was using `wmic /format:csv`. If a process executable path or arguments contained a comma, it destroyed the CSV column alignment, returning `NaN` for memory values and breaking the parser.
**The Fix:** Switched to `wmic ... /format:value`, which outputs `Key=Value` blocks separated by blank lines (`\r\n\r\n`). This entirely avoids comma conflict hazards.

## 5. Heavy Process Tree Infinite Loops
**The Issue:** The heavy process tree traversal (`getHeavyProcessTree`) recursively mapped child processes to their parents. In edge cases where a process reported itself as its own parent or circular adoption occurred, the plugin threw a Maximum Call Stack Exceeded exception.
**The Fix:** Implemented graph cycle detection using a `visited` Set during tree traversal. If a PID attempts to loop, it renders `- cycle detected` and safely terminates that branch.