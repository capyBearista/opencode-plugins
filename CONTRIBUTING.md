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

For changes intended for the next package release, add a changeset with `bun run changeset` and select the bump. Packages are independently versioned.

Plugin majors track OpenCode majors, not strict semver. A package in release class `vN` (see `tools/release-channels.json`) only ever publishes major N, so:

- Use `patch` for fixes and `minor` for features **and for breaking changes** within the same OpenCode major. Say "Breaking" in the changeset text so it lands in the changelog.
- Use `major` only to move a package to a new OpenCode major. Change its `releaseClass` in `tools/release-channels.json` and the guard's `APPROVED_POLICY` in the same PR.

`bun run release:changesets` checks pending changesets and package manifests against this rule without touching the registry. The Changesets workflow runs it on pull requests.

### Release channels

- The five V2 ports are published as `2.x` on `latest`.
- The one V1-only package (`opencode-agent-prompt-inheritance`) continues to publish under `latest`. The output-styles V1 line is frozen at `1.0.2`. The loader and timeline V1 releases stay available at `1.0.0` and `1.0.1` by exact pin.
- Keep V1 and V2 version/release batches separate. The guard checks **all unpublished public workspace versions**, not just the packages named in a changeset or Git diff. A mixed batch is rejected before publishing.

Publishing is CI-only. The release workflow uses the `npm-publish` environment and npm trusted publishing, and runs `bun run changeset:publish` through the pinned Changesets Action. Version application and publication require maintainer authorization; do not run a real-registry publish locally.

The release flow on `main`:

1. Merge a PR that carries a changeset. The Release workflow opens (or updates) a **Version Packages** PR with the version bumps and changelog entries.
2. That PR is opened by `github-actions[bot]`, so its checks wait at "action_required". Click **Approve and run workflows** on the PR, then merge it once they pass.
3. The Release workflow publishes the unpublished versions with provenance, then pushes `name@version` tags and creates a GitHub release per package.
4. Verify on the registry with a direct curl (for example `curl -s https://registry.npmjs.org/@capybearista%2F<name>`); `npm view` can lag.

The toolchain is Changesets CLI 3.x with `changesets/action` v2. They are upgraded together: action v2 rejects CLI v2. The guard pins the CLI version as well (see [AGENTS.md](./AGENTS.md)).

Run `bun run release:check` to inspect the complete unpublished set and selected channel. It queries public registry metadata but does not publish or create Git tags. It rejects unsupported package/version combinations (including a version outside its class major), ambiguous batches, and failed or malformed registry responses.

### Publication failures

npm publication is not atomic across packages. If a job fails, inspect registry versions, dist-tags, and CI output before retrying. Changesets v3 reports failures per package and still creates Git tags for the packages that did publish, so a partial job leaves tags for what reached the registry. Re-running the Release workflow publishes only the versions still missing from the registry. Check that each published version also has its GitHub release; create any missing one from its tag. Do not bypass the guard or move a `latest` tag to recover a failed release.

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

**CI** runs typecheck, lint, and test on pushes and pull requests. Markdown, docs, asset, and changeset-only changes skip CI through path filters. The **Changesets** workflow runs `bun run release:changesets` on pull requests that touch changesets, package manifests, or the release policy, so changeset-only PRs are still checked. Releases run separately in the `release` workflow, only from `main`.

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
