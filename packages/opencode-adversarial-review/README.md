# opencode-adversarial-review

<p align="center">Unbiased challenges and reviews for your code</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@capybearista/opencode-adversarial-review"><img alt="npm" src="https://img.shields.io/npm/v/@capybearista/opencode-adversarial-review?style=flat-square&color=8d60e6" /></a>
  <a href="https://www.npmjs.com/package/@capybearista/opencode-adversarial-review"><img alt="npm" src="https://img.shields.io/npm/dm/@capybearista/opencode-adversarial-review?style=flat-square&color=6067e6" /></a>
  <a href="https://opencode.ai"><img alt="opencode" src="https://img.shields.io/badge/OpenCode-Plugin-orange?style=flat-square&color=60a5e6" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img alt="license" src="https://img.shields.io/badge/License-MPL--2.0-blue.svg?style=flat-square&color=60dfe6" /></a>
</p>

---

## Why?

Two code review agents with a clean-context subagent each, so reviews are unbiased by conversation history: an **adversarial reviewer** that challenges approach and design choices (modeled on the Codex CLI's review system), and a **constructive reviewer** that checks correctness first and suggests improvements.

## Philosophy: Extending OpenCode

OpenCode is designed to be highly extensible. This plugin hooks into the review lifecycle to add adversarial and constructive passes directly to your workflow.

### Architecture

One config drives two sandboxed subagents: agents register in memory, commands install to disk, prompts ship with the code.

One `REVIEWERS` config drives both agents; only identity, command file, and prompt differ:

- **Agents**: setup registers the hidden `adversarial-reviewer` and `constructive-reviewer` subagents through `agent.transform`. Nothing is written to your agents directory.
- **Commands**: setup installs `commands/adversarial-review.md` and `commands/constructive-review.md` into your OpenCode config directory. The host discovers them as `/adversarial-review` and `/constructive-review` and routes each to its reviewer with `subagent: true`.
- **Prompts**: `src/prompt.ts` holds both system prompts; `src/prompts/adversarial-review.md` and `src/prompts/constructive-review.md` are their reference copies. All review doctrine — target selection, evidence rules, output contract — lives there, never in the command templates.

```mermaid
graph TB
    subgraph Host [OpenCode Host]
        User([User]) -->|"/adversarial-review / /constructive-review"| Command[Installed Command Templates]
        Command -->|"$ARGUMENTS + five shell blocks"| Reviewer
    end

    subgraph Plugin [Plugin]
        Setup[setup] -->|agent.transform| Reviewer{"adversarial-reviewer<br/>constructive-reviewer<br/>hidden subagents"}
        Setup -->|"atomic install; stamped refresh"| Command
    end

    subgraph Review [Review Session]
        Reviewer -->|self-collected evidence| Tools[read / grep / glob / git / gh]
        Tools --> Reviewer
        Reviewer -->|"requested output: JSON / Markdown"| User
    end

    classDef host fill:#bbf,stroke:#333,stroke-width:2px;
    classDef plugin fill:#dfd,stroke:#333,stroke-width:1px,stroke-dasharray: 5 5;
    classDef adversary fill:#f9f,stroke:#333,stroke-width:2px;

    class Host host;
    class Plugin plugin;
    class Review adversary;
```

## Features

- **Two reviewers**: adversarial (reasons *not* to ship) and constructive (correctness first, then suggestions).
- **Reviewer-collected evidence**: changed files, untracked files, and branch diffs are inspected with read-only tools; only verified findings are reported.
- **Auto-installed commands**: both slash commands are written on first setup; stamped files refresh on `/reload`, user-owned edits are preserved (see note below).
- **Targets**: `--scope`, `--base`, bare commit SHA, or PR URL/number on both commands.
- **No pinned temperature or model**: both inherit from the invoking chain.

## Requirements

- Tested on GNU/Linux with a Bash-compatible shell. Elsewhere the five snapshot blocks may render partially; the reviewer is told the snapshot may be incomplete and self-collects the rest.
- `git` on `PATH`; `gh` installed and authenticated only for pull request targets.
- A writable `<config>/commands/` directory (see Install).

## Install

Targets the V2 Promise plugin API (`@opencode/plugin` **2.0.2**); not compatible with a V1 host. Add it under the plural `"plugins"` key:

```json
{
  "plugins": ["@capybearista/opencode-adversarial-review@latest"]
}
```

Server entry only, so `cli.json` needs no entry. Or via CLI: `opencode2 plugin add @capybearista/opencode-adversarial-review`. V1 hosts use the singular `"plugin"` key and the V1 line — see the [V1 plugin guide](../../docs/v1-plugins.md).

> [!IMPORTANT]
> The V2 port is unreleased until `2.0.0` publishes. Until then `@latest` still resolves to the V1 `1.0.0` line, which requires a V1 host. This package publishes `2.0.0` to the `latest` tag, not the `opencode2` channel.

On setup, both command files install at `<OPENCODE_CONFIG_DIR ?? ~/.config/opencode>/commands/{adversarial-review.md,constructive-review.md}`. The directory must already exist; if a file cannot install, setup fails loudly and **neither** agent is registered.

> [!NOTE]
> The installed command files are managed via a `managed_version` stamp in their frontmatter. Keep the stamp and the file refreshes from the bundled template on `/reload`; remove it to take ownership — the file is then left untouched with a warning. Unknown or newer stamps are likewise preserved (downgrades never clobber). A failure partway can leave the first file as a harmless orphan; it is reconciled on the next `/reload`, and registration still waits for both files. Delete a file and `/reload` to force-reinstall; uninstall the plugin *and* delete both files to fully remove the commands.
>
> The same ownership rule cleans up an upgrade leftover: a pre-rename build installed the second command as `commands/review.md` with `agent: reviewer`, an agent this version no longer registers, so the host discovers it as a broken `/review`. Setup removes that exact file only when it carries `agent: reviewer` plus a `managed_version` stamp this build knows; any other `review.md` is preserved, with a warning when it carries the old agent id. Setup never deletes a file on a failed refresh unless its `O_TRUNC` open already ran — an unreadable/unwritable managed file is left intact and setup fails loudly instead.

### Updating

`opencode2 plugin check` / `opencode2 plugin update` move the configured target (restart alone upgrades nothing; stop active sessions first). Command-file refresh follows the stamp rules in the note above.

### Uninstall

Remove the plugin from `"plugins"` (or `opencode2 plugin remove @capybearista/opencode-adversarial-review`), then delete both installed command files — plugin removal does not delete them, and the host would otherwise keep discovering commands with no agents behind them.

## Usage

Both commands accept `--scope auto|working-tree|branch`, `--base <ref>`, a bare commit SHA, or a PR URL/number. A PR URL always wins; otherwise the first bare token decides (all-decimal → PR, 7+ hex chars with a letter → commit); an explicit target beats the flags. `/adversarial-review` treats remaining text as a focus area; `/constructive-review` ignores trailing non-flag text (no focus support).

```bash
/adversarial-review                  # working tree (or branch, if tree is clean)
/adversarial-review --scope branch   # current branch since fork point
/adversarial-review 4f2a9c1e         # a commit
/adversarial-review 42               # PR #42 (bare number; hex SHAs stay commits)
/constructive-review --scope working-tree  # constructive pass, working tree only
/constructive-review --scope branch        # constructive pass, current branch since fork point
/constructive-review 4f2a9c1e              # constructive pass, a commit
/constructive-review 42                    # constructive pass, PR #42
```

## Configuration

Nothing is pinned — model and temperature are both inherited. Resolution order for the model: frontmatter `model` (add manually to pin) → agent `model` in OpenCode config → invoking session's model, with its temperature. To pin a reviewer model, set it in `opencode.json`/`opencode.jsonc`:

```jsonc
{
  "agents": {
    "adversarial-reviewer": { "model": "openrouter/openai/gpt-6-sol" },
    "constructive-reviewer": { "model": "openrouter/openai/gpt-6-sol" }
  }
}
```

## Permissions & Security

Both reviewers are sandboxed and unattended; the single accepted risk is pasted arguments (below). Details:

**Pasted arguments become executable template content.** `$ARGUMENTS` is substituted before the snapshot blocks run, so argument text can execute as shell. Inspect arguments before invoking, and never pass untrusted or pasted Markdown containing backtick blocks.

One shared sandbox: `edit`/`write`/`patch`, `subagent`, `skill`, `webfetch`/`websearch`, `question` denied (zero ask — reviewers run unattended); shell limited to 13 read-only `git` patterns plus `gh pr view*`/`gh pr diff*` and the `gh auth status*` diagnostic (token-printing and all other `gh` denied); `read`/`grep`/`glob` allowed except `.env`/`.env.*` (`.env.example` allowed, as is `git show <rev>:<path>` of a `.env.example` blob). See `AGENTS.md` for the full rule inventory.

## Troubleshooting

- **Setup failed installing a command file**: create (or fix permissions on) `<config>/commands/`, then `/reload`. A readable-but-unwritable managed file is left untouched, never deleted.
- **"Leaving it untouched" warning**: the file is user-owned or carries an unknown/newer stamp — edit in place, or delete to reinstall.
- **Broken `/review` after upgrading**: a pre-rename build's `commands/review.md` references the removed `reviewer` agent. Setup removes it when it carries a known stamp; an unstamped copy is preserved with a warning — delete that file manually.
- **File replaced on `/reload`**: it kept a known stamp and was refreshed; remove the stamp to take ownership.
- **"No changes to review"**: stage changes or pass `--base`.
- **PR target fails**: needs authed `gh`; the reviewer reports that plainly (stderr verbatim on failure).
- **Large diffs**: use a model with a bigger context window; reviewers also read files as they work.
- **Not a git repo**: the template needs `git` on `PATH` inside a repository.

## Contributing

This package lives in the `opencode-plugins` monorepo. Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR. Please check for existing issues first.

## License

[MPL-2.0](./LICENSE.txt)
