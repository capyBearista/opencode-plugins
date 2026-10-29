# RAM attribution and TUI behavior

The displayed totals separate OpenCode (TUI + server) from Tools (server descendants and applicable orphaned terminal daemons). A server PID is accepted only after process verification. Review changes for omission and double counting across process trees, including a TUI launched inside an OpenCode terminal.

Process collection and command parsing differ across Linux and Windows. Do not assume POSIX tools or quoting work on Windows; use the existing documented platform boundary.

This is a TUI-only package. Polling begins in a mounted component, uses non-overlapping recursive timeouts, and must be cleaned up on unmount. The package must not become a server plugin as a side effect of packaging changes.
