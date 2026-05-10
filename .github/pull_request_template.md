## Summary

<!-- Describe the change and why it is needed. -->

## Linked Issue

<!-- Use "Fixes #..." or "Refs #..." if corresponding issue available. If no issue exists, include a short rationale/scope summary. -->

## Plugin(s) Affected

- [ ] opencode-agents-loader
- [ ] opencode-double-tap-timeline
- [ ] opencode-output-styles
- [ ] opencode-ram-monitor
- [ ] opencode-plugins (this monorepo itself)
- [ ] Other: _______

## Type of Change

<!-- Mark the relevant option with an [x] -->

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Other: _______

## OpenCode Validation

- OpenCode version tested:
- Runtime smoke test performed:

## Quality Checklist

- [ ] I ran `bun run typecheck && bun run lint && bun run test`
- [ ] I ran `bun run build`
- [ ] This is the smallest safe root-cause fix (no unnecessary logic changes)
- [ ] I preserved behavioral invariants and added/updated tests as needed
- [ ] For plugin/runtime changes, I verified the built module or package export that OpenCode actually loads
- [ ] If local `.opencode` config was part of testing, I verified it points at the package root or published plugin name rather than a stale `dist/*` artifact
- [ ] For bug fixes, I captured the root cause and why earlier symptoms/reviewer findings were misleading
- [ ] I updated docs for user-facing changes
- [ ] I have read the [Contributing Guidelines](../CONTRIBUTING.md)

## Screenshots <!-- delete if unused -->

<!-- If applicable, add screenshots to help explain your changes. -->

## Additional Context <!-- delete if unused -->

<!-- Add any other context about the PR here. -->
