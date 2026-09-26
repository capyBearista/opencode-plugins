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

> Provides two code review agents — an adversarial reviewer that challenges implementation approach and design choices, and a constructive reviewer that checks correctness first and suggests improvements. Both use a clean-context subagent so the review is unbiased by conversation history.

## Philosophy: Extending OpenCode

OpenCode is designed to be highly extensible. This plugin hooks into the OpenCode lifecycle to provide additional functionality seamlessly into your workflows. It is modeled on the Codex CLI's review system: the adversarial path focuses on "breaking confidence" rather than validating changes, and the constructive path focuses on correctness and suggestions.

### Architecture

The plugin owns both reviewer agents and installs the commands that route to them. One `REVIEWERS` config drives both; only identity, command file, description, and prompt differ:

- **Agents (in memory)**: setup registers the hidden `adversarial-reviewer` and `reviewer` subagents through `agent.transform`. Nothing is written to your agents directory.
- **Commands (on disk)**: setup installs `commands/adversarial-review.md` and `commands/review.md` from the packaged templates into your OpenCode config directory. The host discovers them as `/adversarial-review` and `/review` and routes each to its reviewer with `subagent: true`.
- **Prompts (packaged)**: `src/prompt.ts` holds both system prompts; `src/prompts/adversarial-review.md` and `src/prompts/review.md` are their reference copies.

```mermaid
graph TB
    subgraph Host [OpenCode Host]
        User([User]) -->|"/adversarial-review / /review"| Command[Installed Command Templates]
        Command -->|"$ARGUMENTS + five shell blocks"| Reviewer
    end

    subgraph Plugin [Plugin]
        Setup[setup] -->|agent.transform| Reviewer{"adversarial-reviewer<br/>reviewer<br/>hidden subagents"}
        Setup -->|"wx install once per file"| Command
    end

    subgraph Review [Review Session]
        Reviewer -->|self-collected evidence| Tools[read / grep / glob / git]
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

Each reviewer runs as a linked background child of the invoking session, so the review is unbiased by the primary agent's conversation history. It collects its own evidence with read-only `read`, `grep`, `glob`, and whitelisted `git` commands; the command template only primes it with a point-in-time Git snapshot.

## Features

- **Two Reviewers**: An adversarial subagent prompted to find reasons *not* to ship, and a constructive subagent prompted to check correctness first and suggest improvements.
- **Reviewer-Collected Evidence**: Both reviewers inspect changed files, untracked files, and branch-scope diffs themselves with read-only tools, then report only what they verified.
- **Auto-Installed Commands**: First setup writes `/adversarial-review` and `/review` into your global commands directory; each write is atomic and write-once.
- **Requested Output Formats**: The adversarial prompt asks for structured JSON with severity, locations, and confidence; the review prompt asks for a verdict-led Markdown report with findings and suggestions.
- **Configurable Scope**: Support for `--base <ref>`, `--scope branch`, and `--scope working-tree` on both commands.

## Requirements

- GNU/Linux with a Bash-compatible shell. The command template is not tested on Windows or macOS and makes no cross-platform parity claims.
- `git` on `PATH`.
- A writable `<config>/commands/` directory (see Install).

## Install

This package targets the V2 Promise plugin API (`@opencode/plugin` **2.0.2**) and exports a default `Plugin.define({ id, setup })` definition; it is not compatible with a V1 host. Add it to your V2 server profile's `opencode.json` or `opencode.jsonc` under the plural `"plugins"` key:

```json
{
  "plugins": ["@capybearista/opencode-adversarial-review@latest"]
}
```

The plugin ships a server entry only, so `cli.json` needs no entry. You can also install it through the V2 CLI:

```bash
opencode2 plugin add @capybearista/opencode-adversarial-review
```

V1 hosts use the singular `"plugin"` key and the V1 release line, not this V2 API; see the [V1 plugin guide](../../docs/v1-plugins.md) to keep the two lines apart.

On setup, the plugin installs both command files at:

```
<OPENCODE_CONFIG_DIR ?? ~/.config/opencode>/commands/adversarial-review.md
<OPENCODE_CONFIG_DIR ?? ~/.config/opencode>/commands/review.md
```

The parent `commands/` directory must already exist and be writable. If a file cannot be installed, setup fails loudly and **neither** reviewer agent is registered — a registered agent with no command would be a broken setup. Installs run in order, so a failure on the second file can leave the first file on disk as a harmless orphan; on the next restart that file is reused with the EEXIST warning, and registration still waits until both files install. If a file already exists, the plugin leaves it untouched and logs a warning naming that path; the file may be stale or customized, and only you can decide which.

### Updating

Plugin upgrades never overwrite the installed command files. To pick up a new template, delete the file and restart OpenCode; setup installs the bundled version again. To keep local changes, edit the installed file in place.

Updating the plugin package itself follows the V2 flow: `opencode2 plugin check` reports available updates and `opencode2 plugin update` moves the configured target. A restart alone does not upgrade a cached target, and exact pins stay fixed. Stop active sessions first.

### Uninstall

Remove the plugin from the `"plugins"` array in `opencode.json` / `opencode.jsonc` (or run `opencode2 plugin remove @capybearista/opencode-adversarial-review`), then delete the installed command files:

```bash
rm ~/.config/opencode/commands/adversarial-review.md ~/.config/opencode/commands/review.md
```

If the plugin is still registered, the next setup reinstalls them.

## Usage

Run a review on your current working tree changes:
```bash
/adversarial-review
```

### Arguments

`/adversarial-review` and `/review` accept the same `--scope` and `--base` flags:

| Argument | Values | Description |
| :--- | :--- | :--- |
| `--scope` | `auto`, `working-tree`, `branch` | The range of changes to review. Defaults to `auto`. |
| `--base` | `<git-ref>` | The base reference (branch or commit) to compare against when using `branch` scope. |

- **`auto`**: Reviews the working tree when it has staged or unstaged changes; otherwise reviews the current branch.
- **`working-tree`**: Reviews staged and unstaged changes against `HEAD`.
- **`branch`**: Reviews all changes on the current branch since it diverged from the upstream or main branch.

`/adversarial-review` treats any trailing text after the flags as a focus area; `/review` does not support focus areas (see below).

- **`focus ...`** (`/adversarial-review` only): Any trailing text is treated as a focus area for the review.

### Examples

Force review of only working tree changes (ignoring branch history):
```bash
/adversarial-review --scope working-tree
```

Review all changes on the current branch (automatically finds the fork point):
```bash
/adversarial-review --scope branch
```

Review a specific branch against its fork point from `main`:
```bash
/adversarial-review --base main
```

Review `/adversarial-review` with a specific focus area:
```bash
/adversarial-review --base main focus on race conditions in the auth middleware
```

### Constructive review (`/review`)

The plugin also ships a constructive reviewer for the same change:

```bash
/review
```

`/review` installs at `<OPENCODE_CONFIG_DIR ?? ~/.config/opencode>/commands/review.md`, routes to the hidden `reviewer` subagent, and reviews correctness first, then material maintainability risk. It accepts the same `--scope` and `--base` flags as `/adversarial-review`, with the same defaults and semantics.

- **No focus text**: trailing non-flag text is ignored. Focus areas are not supported for `/review` (Codex parity); only `--scope` and `--base` change what is reviewed.
- **Markdown output**: the reviewer is asked for a `Verdict:` line, findings with severity and file/line references, and a suggestions section. Like the adversarial JSON contract, this is *requested*, not enforced: no tool validates the answer, and the prompt asks for the report verbatim — no code fences or commentary around it.
- **Shared constraints**: `/review` uses the same read-only sandbox, the same five shell blocks, and the same paste-risk surface described below.

Example:

```bash
/review --scope branch --base main
```

## Configuration

Neither shipped command has a `model:` line. The host resolves the review model in this order:

1. `model` in the installed command file's frontmatter (add it manually to pin one),
2. `model` configured for the `adversarial-reviewer` / `reviewer` agent in your OpenCode config,
3. the invoking session's model.

The reviewer inherits the invoking session's model when none of the above is set. The plugin also pins the review temperature to `0.1` through session hooks, scoped to the two reviewer agent identities. Those hooks fire for every session in the host, so the plugin logs a one-time warning per observed non-reviewer agent identity (including events with no agent) instead of skipping silently.

Output format is *requested*, not enforced. The adversarial prompt asks for one verbatim JSON object and the review prompt asks for a verbatim Markdown report, but neither the plugin nor the host validates the answer. A child run that fails reaches the parent as `state="error"`; malformed-but-completed text arrives as a normal completed message. Read the output as model text, not as a validated contract.

## Permissions & Security

Both subagents share one strict sandbox that prevents accidental or malicious modifications to your codebase:

- **Edit**: Explicitly denied (`edit`, `write`, and `patch`).
- **Shell**: Restricted to a read-only whitelist of 12 git patterns (e.g., `git diff`, `git log`, `git status`); branch access is limited to `git branch --show-current`. Diff-engine flags that execute configured drivers or write files (`--ext-diff`, `--textconv`, `--output`) are denied after the allow list for `diff`, `show`, `log`, and `stash show`. Neither reviewer can run general shell commands or delegate to other subagents.
- **Read/Grep/Glob**: Allowed (read-only) to enable code inspection, except resources matching `.env`/`.env.*`, which are denied after the general allow; `.env.example` stays allowed.
- **Skills & Delegation**: `skill` activation and `subagent` delegation are denied, so neither reviewer can chain into other capabilities.
- **Network**: Web fetch and search, and `question`, are denied; both reviewers run unattended without ask prompts. Inherited `ask` rules are dropped at setup for the same reason — an ask would stall a background run — while the explicit allows and denies above still apply.

The `/adversarial-review` and `/review` commands route to hidden reviewers; each description tells agents not to invoke its reviewer directly. A direct spawn is still technically possible, but it is unsupported and caller-controlled.

### Shell blocks run outside the permission flow

Each installed template contains five `!`-backtick blocks (branch, status, recent commits, working-tree diff, untracked file list). The host evaluates them with your shell while expanding the command, **before** the reviewer's permission rules apply. They run read-only git commands with your user's privileges in the project directory. Read the installed files before using them in an untrusted repository.

**Accepted risk — argument paste warning.** The host substitutes `$ARGUMENTS` into a template before it scans for the `!`-backtick shell blocks, so argument text can become executable shell content. Both commands are human-invoked surfaces only: typed or pasted arguments containing `!`-backtick blocks execute as shell commands with your user's privileges in the project directory. This risk is accepted and documented; no host-side fix is planned. Do not pass untrusted or pasted Markdown containing backtick blocks as arguments to either command. Inspect the arguments before invoking, and pass only text you would type into your own shell.

### Context disclosure

Invoking `/adversarial-review` or `/review` consents to sending review context to the reviewer model: a template-rendered Git snapshot (branch, status, recent commits, `git diff HEAD`, untracked file paths) plus anything the reviewer reads with its tools. The rendered snapshot is a point-in-time starting point, not a complete record: it can miss files, skip binary content, or fail to render, and the reviewer is instructed to verify with its own tools. The plugin does not scan for secrets; check your `.gitignore` and tracked files before running a review on a tree that contains them. Reads, greps, and globs whose permission resource matches `.env` or `.env.*` are denied to the reviewers; `.env.example` remains allowed.

## Troubleshooting

- **Setup failed with "Unable to install the /adversarial-review command" or "Unable to install the /review command"**: Create the `commands/` directory under your OpenCode config directory (or fix its permissions), then restart. Neither reviewer is registered until both command files install.
- **The command file warning says "leaving it untouched"**: That file already exists. Edit it in place to keep local changes, delete it to reinstall the bundled template, or delete it after removing the plugin to finish an uninstall.
- **The command files remain after uninstalling the plugin**: Plugin removal does not delete them. Delete them manually (see Uninstall) so the host stops discovering `/adversarial-review` and `/review` with no reviewer agents behind them.
- **The temperature hook warns about a non-reviewer agent**: Expected. The hooks run host-wide and pin `0.1` only for `adversarial-reviewer` and `reviewer` events; the warning is emitted once per observed agent identity.
- **"No changes to review"**: Ensure you have staged or unstaged changes, or use `--base` to review a committed branch.
- **Model timeouts**: Large diffs may require a model with a larger context window or more time. The reviewer can also read files with its tools while it works.
- **Git errors**: Ensure you are running within a git repository. The template relies on `git` being available in your PATH.

## Contributing

This package lives in the `opencode-plugins` monorepo.

- Run `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test` before opening a PR.
- Keep the plugin focused on the two code review functions.
- Prefer small, direct changes.

Please open an issue or check for existing ones before creating a pull request.

## License

[MPL-2.0](./LICENSE.txt)
