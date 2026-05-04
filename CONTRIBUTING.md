# Contributing to OpenCode Plugins

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the monorepo
git clone https://github.com/capybearista/opencode-plugins
cd opencode-plugins

# Install dependencies
bun install
```

## Quality Gates

Before opening a pull request, run the full quality gate:

```bash
bun run build && bun run typecheck && bun run lint && bun run test
```

Auto-format all code with Biome (`bun run check` runs `biome check --write` in every package):

```bash
bun run check
```

## Commit Messages

We use **conventional commits**. Your commit messages must follow this format:

```
type(scope): description
```

Where `type` is one of:
- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation changes
- `style` — formatting, no logic changes
- `refactor` — code restructuring
- `perf` — performance improvements
- `test` — test changes
- `build` — build system changes
- `ci` — CI/CD changes
- `chore` — maintenance, dependencies
- `revert` — reverting a previous commit

Examples:
```
feat(output-styles): add /style clear command
fix(agents-loader): resolve path discovery bug
docs(readme): update install instructions
```

A commit-msg hook will block commits that don't follow this format.

## Making Changes

1. Create a branch: `git checkout -b feat/my-feature`
2. Make your changes
3. Add tests if applicable
4. Run quality gates
5. Commit with conventional commit format
6. Push and open a PR

## Automation

The repository uses **Husky** to enforce quality on every commit:

- **Pre-commit** — runs `graphify update .` to keep the project knowledge graph current
- **Commit-msg** — enforces conventional commits via `commitlint`

**CI** runs on every push via GitHub Actions (typecheck, lint, test).

## Monorepo Structure

- `packages/` — published OpenCode plugins
- `tools/` — auxiliary scripts and utilities (e.g., the Cloudflare Worker for the total-downloads badge)
- `docs/` — internal documentation and upstream prompt snapshots

Each package in `packages/` is independently versioned and published via Changesets.

## Code Style

- **TypeScript strict mode** is required
- **Biome** handles linting and formatting (`bun run check` to auto-fix)
- **Zero comments by default** — only add when code isn't self-explanatory
- **No `console.log`** — use structured approaches for logging
- **Colocate tests** with source files (`src/index.test.ts`)

## License

All contributions are released under the MPL-2.0 license.