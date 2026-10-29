# Agent and command bridge review

This plugin adds discovery for shared `.agents/` sources without replacing OpenCode's native discovery and precedence rules. Source content is not rewritten; native directories receive managed relative symlinks.

Review filesystem changes through an ownership lens: identify the source scope, target parent, manifest record, native-name reservation, lock, and cleanup step. User-authored native content must remain untouched.

Frontmatter validation is a permission boundary. Unsupported metadata should be skipped with a diagnostic rather than implicitly made permissive. Use V1/V2 distinctions in the package AGENTS.md.

The watcher emits reload signals, but host rescans or restarts may still be necessary. Do not demand immediate hot-reload behavior that the current contract does not promise.
