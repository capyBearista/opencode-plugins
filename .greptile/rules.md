# Repository review guidance

This is a Bun/Turborepo monorepo of independently published OpenCode plugins. The root `AGENTS.md`, applicable package `AGENTS.md`, and `CONTRIBUTING.md` define development and verification conventions; use them as evidence rather than restating them as findings.

- Prioritize regressions introduced by the PR: correctness, security, data integrity, compatibility, user configuration, resource lifecycle, and release safety.
- For each finding, identify a concrete triggering input or execution sequence, the affected behavior, and why current guards or tests would not prevent it. Do not infer a bug merely from a missing test or a plausible but unproven risk.
- Treat a documented design trade-off or known limitation as baseline. Report a newly introduced or worsened failure, not a request to redesign an established choice.
- Distinguish OpenCode V1-only code from V2 Promise API server plugins, V2 TUI plugins, and combined server/TUI packages. Use package-level compatibility guidance and verified host behavior.
- Pay attention to the distinction between source, built artifacts, package exports, local-directory installs, and published installations when a PR changes loading or packaging.
- Keep suggestions proportional. Biome and CI already enforce routine formatting and static checks; avoid duplicating their feedback.
- Documentation marked historical or a scoped upstream snapshot is not a claim about the latest OpenCode release. Only flag it when the PR makes an incorrect new claim or breaks current documentation links.
- Do not recommend broadening permissions, removing existing safety checks, or introducing new public configuration solely for convenience.
