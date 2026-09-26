# AGENTS.md

## Overview

**Technology**: TypeScript / OpenCode Plugin
**Entry Point**: `src/index.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: V2 (`@opencode/plugin` 2.0.2, `Plugin.define`) — server entry only, no TUI. The release policy still lists the V1 `latest` line (`releaseClass: v1`) pending reclassification; keep V1 (singular `plugin` key) and V2 (plural `plugins` key) hosts apart.

This plugin provides **adversarial code review** for OpenCode — reviewing code changes with a "break confidence, not validate" mindset. It ports the Codex CLI's adversarial review concept to OpenCode's agent system.

## Architecture

### Two Components, Split by Lifetime

1. **Agent (in memory)** — `src/index.ts` `setup()` registers the hidden `adversarial-reviewer` subagent through `ctx.agent.transform`. No agent file is ever written. The plugin enforces the do-not-invoke description, `subagent` mode, hidden flag, and the read-only permission set; a host-defined `system` or `color` survives the update.

2. **Command (on disk)** — `commands/adversarial-review.md` is the packaged template. `setup()` installs it once, atomically (`wx`), at:

   ```
   <OPENCODE_CONFIG_DIR ?? ~/.config/opencode>/commands/adversarial-review.md
   ```

   The host discovers it as `/adversarial-review` and, because the frontmatter sets `agent: adversarial-reviewer` and `subagent: true`, routes it to a linked background child of the invoking session. The host expands the template: `$ARGUMENTS` substitution first, then the five `!`-backtick shell blocks (branch, status, recent commits, `git diff HEAD`, untracked file list).

3. **Prompt (packaged)** — `src/prompt.ts` holds the canonical system prompt; `src/prompts/adversarial-review.md` is the lockstep reference copy. `src/index.ts` stays limited to agent registration, the command install, and temperature hooks: the reviewer collects evidence with its own read-only tools, and the plugin never post-processes its answer.

### Flow

```
User: /adversarial-review --base main check auth
  ↓
Host expands the installed template (arguments, then shell blocks)
  ↓
Child session (agent: adversarial-reviewer, parent-linked background subagent)
  ↓
Reviewer: scope selection → self-collected evidence (read/grep/glob/git) → JSON text
  ↓
Parent session receives the child result as-is
```

Model resolution is the host chain: command frontmatter `model` → configured `adversarial-reviewer` agent model → invoking session model. The shipped template has no `model:` line, so the parent model is inherited by default. Structured JSON is requested by the prompt; neither the plugin nor the host validates it. A failed child surfaces as `state="error"`; malformed-but-completed text surfaces as completed.

### Key Design Decisions

- **No custom tool**: Context priming comes from the installed command template's shell blocks; the reviewer self-collects the rest with whitelisted read-only tools.
- **No primary agent involvement**: `subagent: true` routes directly to the reviewer. Zero conversation history leak.
- **Least privilege**: `edit`/`write`/`patch`, `subagent`, `skill`, `question`, `webfetch`, `websearch`, `external_directory`, and general `shell` are denied; `read`/`glob`/`grep` and 12 `git` command prefixes are allowed (`git branch` is limited to `--show-current`; `--ext-diff`/`--textconv`/`--output` are denied after the allows). `.env`/`.env.*` is denied after the general allow for read, grep, and glob. Inherited `ask` rules are dropped because the reviewer runs unattended, and pre-existing host denies are re-appended after the plugin rules so they outrank plugin allows.
- **Write-once install**: `wx` refuses to replace an existing file, including a symlink. EEXIST logs a stale-or-customized warning naming both update paths (edit in place or delete) and the delete-to-uninstall step; permission/missing-parent failures abort setup so the agent is never registered without its command.
- **Reviewer-scoped temperature**: the `context`/`generate` hooks fire host-wide and pin `0.1` only for `adversarial-reviewer` events; each distinct non-reviewer agent identity (including a missing agent) is warned about once so skipped events are visible without flooding host logs.
- **No checksums or markers**: the plugin does not try to detect whether an existing file is its own; manual edits are preserved.

### Maintenance Rules

- Keep `src/prompt.ts` and `src/prompts/adversarial-review.md` byte-for-byte in lockstep (the test asserts it).
- Keep `commands/adversarial-review.md` shipped through the package.json `files` array; it is loaded relative to the built entry as `../commands/`.
- Keep the frontmatter minimal: `description`, `agent: adversarial-reviewer`, `subagent: true`. No `model:` line.
- When changing tool permissions, re-check the least-privilege model and the installed template's shell blocks together.
- Platform scope is GNU/Linux + Bash only; do not claim cross-platform parity without a tested port.

### Edge Cases

- **Existing command file**: left untouched with a warning. Stale templates are refreshed only by deleting the file and restarting. Uninstalling the plugin does not delete the file; manual removal is the uninstall step.
- **Missing/unwritable `commands/` directory**: setup throws with the path; no agent is registered.
- **No changes**: the shell blocks render empty output; the reviewer reports there is nothing to review.
- **Large diff**: the template's diff block may be large; the reviewer reads surrounding code and untracked contents with its tools rather than assuming the snapshot is complete.
- **No git repo**: each shell block appends `2>&1 || true`, so failures render as text instead of aborting the command.
- **Injection warning (accepted paste-risk)**: `$ARGUMENTS` is substituted before the shell blocks are evaluated, so argument text can become executable shell content. The command is human-invoked; the risk is accepted and documented, with no host-side fix planned. Safe invocation: inspect arguments before invoking, and never pass untrusted or pasted Markdown containing backtick blocks as arguments.

## Quick Reference

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `bun run build`     | Compile TypeScript         |
| `bun run typecheck` | Type check                 |
| `bun run lint`      | Lint (Biome)               |
| `bun run check`     | Lint and format (Biome)    |
| `bun run ci`        | CI mode (non-mutating)     |
| `bun test`          | Run tests                  |
| `bun run smoke`     | Build + built-entry smoke  |

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use the host `app.log` sink when available (see `createHostLogger`).
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Install tests run setup in a subprocess with an isolated temp `HOME`; never write to the real config directory in tests or smoke.
- Runtime smoke: `bun run smoke` verifies the built entry registers the reviewer agent, enforces the permission/description contract, and pins temperature for the reviewer only.

## License

MPL-2.0