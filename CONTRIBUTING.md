# Contributing to OpenCode Plugins

Thank you for your interest in contributing!

## Development Setup

```bash
# Clone the monorepo
git clone https://github.com/capybearista/opencode-plugins
cd opencode-plugins

# Install dependencies
bun install --frozen-lockfile
```

The repo pins Bun **1.3.12** (`packageManager`). The release workflow also pins Node **24.11.1** and npm **11.19.0**. Match these versions when testing publishing behavior.

When using linked Git worktrees, check the working directory before installing or building. Husky can update the Git configuration shared by those worktrees. For isolated validation, use `HUSKY=0 bun install --ignore-scripts --frozen-lockfile`; do not clean another checkout's build output or change shared Git configuration as a workaround.

## Quality Gates

The canonical command is `bun run test`: it runs the release-guard tests, then Turbo's per-package test processes. Do not substitute bare `bun test` at the repo root; it bypasses package isolation and can share mocks between unrelated packages. Turbo's package tests depend on `build` because some tests inspect built artifacts.

Before opening a pull request, run the full gate:

```bash
bun run build && bun run typecheck && bun run lint && bun run test
```

`bun run check` runs `biome check --write` in every package, so it edits files. `bun run lint` checks release tooling and packages without writing fixes. `bun run typecheck` likewise covers both surfaces.

## Changesets and releases

For changes intended for the next package release, add a changeset with `bun run changeset` and select the appropriate bump (patch, minor, major). Packages are independently versioned.

### Release channels

- Loader and timeline V2 releases use `opencode2`. Their V1 `latest` tags remain frozen at `1.0.0` and `1.0.1`, respectively. `opencode2` identifies host compatibility, not the package major number.
- The other four V1 packages continue to publish under `latest`.
- Keep V1 and V2 version/release batches separate. The guard checks **all unpublished public workspace versions**, not just the packages named in a changeset or Git diff. A mixed batch is rejected before publishing.
- The initial V2 preparation contains exactly two major changesets, moving loader and timeline to `2.0.0`. It must not bump the other packages.

Publishing is CI-only. The release workflow uses the `npm-publish` environment and npm trusted publishing, and runs `bun run changeset:publish` through the pinned Changesets Action. Version application and publication require maintainer authorization; do not run a real-registry publish locally.

Run `bun run release:check` to inspect the complete unpublished set and selected channel. It queries public registry metadata but does not publish or create Git tags. It rejects unsupported package/version combinations, moved frozen tags, ambiguous batches, and failed or malformed registry responses.

### Publication failures

npm publication is not atomic across packages. If a job fails, inspect registry versions, dist-tags, and CI output before retrying. A retry can publish the remaining packages in a homogeneous batch, but Git tags or GitHub releases from a partially completed job may need separate reconciliation. Do not bypass the guard or move a frozen `latest` tag to recover a failed release.

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

A commit-msg hook blocks commits that don't follow this format. That hook is the only Husky hook installed. There is no pre-commit hook.

## Making Changes

1. Create a branch: `git checkout -b feat/my-feature`
2. Make your changes
3. Add a changeset if the change should ship in a package
4. Add tests if applicable
5. Run quality gates
6. Commit with conventional commit format
7. Push and open a PR

Install and update instructions belong to the root README and the package READMEs. Do not duplicate per-plugin specs in a PR description. Background notes live in [docs/README.md](./docs/README.md); V1 compatibility questions go to [docs/v1-plugins.md](./docs/v1-plugins.md).

## Automation

Husky installs a single **commit-msg** hook that enforces conventional commits via `commitlint`.

**CI** runs typecheck, lint, and test on pushes and pull requests. Markdown, docs, and asset-only changes skip CI through path filters. Releases run separately in the `release` workflow, only from `main`.

## Monorepo Structure

- `packages/` — published OpenCode plugins
- `tools/` — release-channel policy, guard and tests, plus the total-downloads badge worker
- `docs/` — contributor notes and upstream reference snapshots (start at [docs/README.md](./docs/README.md))

Each package in `packages/` is independently versioned and published via Changesets.

## Code Style

- **TypeScript strict mode** is required
- **Biome** handles linting and formatting (`bun run check` to auto-fix, `bun run lint` to inspect)
- **Zero comments by default** — only add when code isn't self-explanatory
- **No `console.log`** — use structured approaches for logging
- **Colocate tests** with source files (`src/index.test.ts`)

## License

All contributions are released under the MPL-2.0 license.
