# Review-specific boundaries

The two reviewers share registration and command-install mechanics but have different packaged prompts. `src/prompt.ts` owns review doctrine; `commands/*.md` owns launch handoff and context snapshots. Check both when changes cross that boundary.

The subagents are intended to be unattended and read-only. Assess effective OpenCode permissions in their actual order, including later inherited denies and secret-reading paths; a tool name appearing in an allowlist does not by itself establish its effective permission.

Command templates are installed into the user's OpenCode configuration and can be refreshed on reload. Treat filesystem ownership, symlink handling, partial writes, and user customization as safety boundaries, not mere implementation details.

The existing AGENTS.md documents accepted shell-expansion and redaction limitations. Only report a new exposure or a meaningful worsening of those documented limits. Give a concrete affected command, input, or file.
