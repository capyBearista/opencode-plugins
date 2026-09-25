# AGENTS.md

## Overview

**Technology**: TypeScript / OpenCode Plugin
**Entry Point**: `src/index.ts`
**Parent Context**: This extends [../../AGENTS.md](../../AGENTS.md)
**Compatibility**: V1-only (`releaseClass: v1`, `latest` channel) — no V2 port in this release.

This plugin provides **adversarial code review** for OpenCode — reviewing code changes with a "break confidence, not validate" mindset. It ports the Codex CLI's adversarial review concept to OpenCode's agent system.

## Architecture

### Three Components

1. **Subagent** (`adversarial-review`): Registered via `config` hook. System prompt is the adversarial review framing. Gets a clean session context. Has git/read/grep/glob tools but no edit permission. Model defaults to `openai/gpt-5.4` for a fresh perspective.

2. **Command** (`/adversarial-review`): Registered via `config` hook. Uses `!`command`` shell injection to collect deterministic git context (branch, status, recent commits, changed files, diff stat). Routes directly to the adversarial-review subagent via `agent` + `subtask: true`. The primary agent never touches the diff.

3. **Prompt** (`src/prompts/adversarial-review.md`): Reference copy of the ported adversarial review prompt. The canonical version is embedded in `src/index.ts`.

### Flow

```
User: /adversarial-review --base main check auth
  ↓
1. Command template renders:
   - `!`git status --short`` → bash output inlined
   - `!`git log --oneline -10`` → recent commits
   - `!`git diff --stat`` → diff summary
   - `$ARGUMENTS` → "--base main check auth"
  ↓
2. Command routes to subagent (agent + subtask: true)
  ↓
3. Subagent gets fresh session:
   System: adversarial review prompt ("break confidence")
   User: rendered command output (git context + args)
  ↓
4. Subagent parses args. If --base detected:
   - Runs `git diff <ref>...HEAD` to collect branch diff
  ↓
5. Subagent returns structured JSON:
   {verdict, summary, findings: [{severity, title, body, file,
     line_start, line_end, confidence, recommendation}], next_steps}
```

The JSON result shape is defined in `src/schemas/review-output.schema.json`.

### Key Design Decisions

- **No custom tool**: Context collection via `!`command`` shell injection in command template. Deterministic bash, not AI.
- **No primary agent involvement**: `subtask: true` routes directly to subagent. Zero conversation history leak.
- **Model override**: Defaults to `openai/gpt-5.4`. User can override in `opencode.json`:
  ```json
  { "agent": { "adversarial-review": { "model": "anthropic/claude-sonnet-4-20250514" } } }
  ```
- **`--base` handling**: Subagent self-collects branch diff with git tools — same pattern as Codex plugin's "self-collect" mode.
- **Permissions**: `edit: deny`, `bash: { "git *": "allow", "*": "deny" }`, read/glob/grep allowed. No destructive tool access.

### Maintenance Rules
- Keep the subagent prompt, command template, and JSON result shape aligned. Small drift between them breaks the whole review loop.
- Prefer deterministic command-template context over adding plugin-side smart behavior.
- When changing tool permissions or shell commands, re-check the least-privilege model documented in the internal postmortem docs.

### Edge Cases

- **No changes**: The full diff is empty → reviewer reports "no changes to review"
- **Large diff**: The complete `git diff HEAD` is inlined with no truncation; the reviewer self-collects surrounding context with read/grep
- **Binary files**: Tracked binaries are diffed by git; untracked binaries are skipped by the NUL check, and the reviewer can read specific text files with its tools
- **No git repo**: `git` failures are labeled as errors in the context → reviewer reports "not a git repository"

## Quick Reference

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `bun run build`     | Compile TypeScript         |
| `bun run typecheck` | Type check                 |
| `bun run lint`      | Lint (Biome)               |
| `bun run check`     | Lint and format (Biome)    |
| `bun run ci`        | CI mode (non-mutating)     |
| `bun test`          | Run tests                  |

## Code Style

- Zero comments by default. Only add when code isn't self-explanatory.
- No `console.log`. Use `client.app.log()` for structured logging.
- Colocate tests with source files (`src/index.test.ts`).
- Imports: builtins first, then external, then relative.

## Testing Guidelines

- Location: colocated
- Framework: bun test
- Running Tests: `bun test`
- Runtime smoke: verify command registration, subagent registration, and JSON-shaped output assumptions against a real OpenCode session when behavior changes

## License

MPL-2.0
