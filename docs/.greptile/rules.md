# Documentation review

`docs/README.md` distinguishes active plugin-author references from historical OpenCode V1 snapshots and dated research notes. Review changes against each document's declared scope and date; do not treat a preserved historical snapshot as a claim about current V2 behavior.

User-facing installation, configuration and compatibility guidance belongs in the root or package READMEs, except the dedicated V1 compatibility guide. Package `AGENTS.md` holds internals and test contracts; `docs/` holds explanatory research and verified findings.

Flag new false compatibility claims, broken local references, or a newly documented behavior contradicted by actual implementation. Avoid reporting deliberate preservation of older upstream guidance as stale technical debt.
