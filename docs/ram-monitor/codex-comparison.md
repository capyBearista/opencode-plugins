# Comparison to the Official Codex-to-Claude-Code Plugin

## Prompt Structure

| Aspect                | Codex                                                                     | Ours                                               |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Template style        | `{{PLACEHOLDER}}` interpolated at runtime                                 | Embedded string constant, no interpolation         |
| `TARGET_LABEL`        | Yes ("working tree diff", "branch diff vs main")                          | Yes ("Target: working tree diff" in template)       |
| `USER_FOCUS`          | Injects focus text, fallback "No extra focus..."                          | Passes through `$ARGUMENTS`, no fallback           |
| `COLLECTION_GUIDANCE` | Two modes: "Use context below" vs "Lightweight summary, inspect yourself" | Yes — `<context_type>` section tells subagent what to expect |
| Core prompt           | 84 lines, almost identical to ours                                        | ~100 lines, ported from Codex with `<context_type>` added |
| 11 XML sections       | Same 11 sections (role→final_check)                                       | Same 11 sections                                   |

**Verdict:** Near-identical core prompt. Previously missing `TARGET_LABEL` and `COLLECTION_GUIDANCE` — now implemented via static template label and `<context_type>` section.

---

## Context Collection

| Aspect                    | Codex                                                                | Ours                                                |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| **Mode**                  | Dual: inline-diff (≤2 files, ≤256KB) vs self-collect (large)         | Dual: inline-diff (≤2 files → full diff) vs stat-only (larger) |
| **Inline diff trigger**   | Yes — full `git diff --binary --cached` + unstaged for small changes | Yes — full `git diff HEAD` for ≤2 files (no --separate staged) |
| **Untracked files**       | Contents included (up to 24KB each)                                  | Included (up to 16KB each, space-safe `while read` loop)      |
| **Commit history**        | Not included                                                         | 3 recent commits included                                     |
| **Diff size measurement** | Estimates files+bytes before running                                 | File count via `wc -l` on `--name-only`, conditional inline     |
| **Staged vs unstaged**    | Separates `--cached` (staged) from unstaged                          | Uses `git diff HEAD` (merged)                       |

**Key gap:** Inline-diff mode gap closed. Remaining: staged vs unstaged separation (currently merged via `git diff HEAD`).

---

## Architecture

| Aspect            | Codex                                                             | Ours                                       |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| Command structure | `.md` slash-command, `disable-model-invocation: true`             | Shell-injected command template            |
| Execution         | Companion Node.js script (git + Codex API)                        | Subagent with bash permission              |
| LLM role          | Claude = thin pipe (no review work)                               | OpenCode = dispatcher, subagent = reviewer |
| Model call        | Direct JSON-RPC to Codex app server (stdin/stdout or Unix socket) | Via OpenCode's provider routing            |
| `outputSchema`    | Server-side enforced by Codex (`turn/start` param)                | Prompt instruction only — no enforcement   |
| Background mode   | `--background` with async job tracking, AskUserQuestion prompt    | Not supported — sync only                  |
| Job persistence   | Job files + `state.json` tracking                                 | None — stateless                           |
| Model reuse       | Broker pattern (lazy-start Unix socket proxy, warm model)         | OpenCode session management                |
| Stop-gate hook    | `Stop` hook triggers fresh adversarial review on session end      | Not implemented (auto-trigger model doesn't align) |

**Key gap:** No output schema enforcement at runtime. Codex's `outputSchema` parameter forces structured JSON server-side. If our model returns invalid JSON, there's no parsing or error surfacing.

---

## Permission & Security

| Aspect            | Codex                                               | Ours                                              |
| ----------------- | --------------------------------------------------- | ------------------------------------------------- |
| Model sandbox     | `sandbox: "read-only"` (Codex server)               | No server sandbox — permission-based via OpenCode |
| Model bash access | None — Codex can't run bash                         | Restricted git whitelist (12 patterns)            |
| Command-level     | `allowed-tools: Bash(git:*)` (Claude, for preamble) | N/A (command template does it)                    |
| Mutability guard  | read-only sandbox = server-enforced                 | `edit: deny` = framework-enforced                 |
| Hook execution    | Not applicable (no bash for Codex)                  | No hook disable flag on our git commands          |

---

## Output Handling

| Aspect                | Codex                                                | Ours                                                      |
| --------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Format enforcement    | `outputSchema` on `turn/start` (server-side)         | Prompt instruction only ("Output valid JSON...")          |
| Parsing               | `JSON.parse()` on final message                      | None                                                      |
| Validation            | `validateReviewResultShape()` checks required fields | None                                                      |
| Error rendering       | "Did not return valid structured JSON" + raw output  | N/A — user sees raw subagent response as-is               |
| Reference schema file | `review-output.schema.json` (used at test time only) | `review-output.schema.json` (test + reference, identical) |

**Key gap:** Inline-diff, TARGET_LABEL, COLLECTION_GUIDANCE, untracked files, and `--scope` all addressed. Remaining gaps: output validation, background execution, job persistence, stop-gate — none critical for the subagent-based architecture.

---

## Testing

| Aspect         | Codex                                             | Ours                                                               |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Runner         | Native Node `node --test`                         | Bun `bun test`                                                     |
| E2E test       | Yes — fake Codex fixture returns structured JSON  | No — only unit tests against config hook                           |
| Test count     | 10 (commands, runtime, git, render, fake fixture) | 19 (config registration, idempotency, permissions, prompt sync)    |
| Coverage areas | Full flow, modes, scope, status, validation       | Registration, idempotency, permissions, prompt sync, partial merge |

---

## Feature Inventory

| Feature                              | Codex | Ours                             |
| ------------------------------------ | ----- | -------------------------------- |
| Inline diff (small changes)          | ✅     | ✅                                |
| Self-collect (large changes)         | ✅     | ✅                                |
| `--base <ref>`                       | ✅     | ✅                                |
| Focus text                           | ✅     | ✅                                |
| `TARGET_LABEL` runtime variable      | ✅     | ✅                                |
| `REVIEW_COLLECTION_GUIDANCE`         | ✅     | ✅                                |
| Structured JSON output               | ✅     | ✅                                |
| Server-side schema enforcement       | ✅     | ❌                                |
| Runtime output validation            | ✅     | ❌                                |
| Background execution                 | ✅     | ❌                                |
| Job tracking / status                | ✅     | ❌                                |
| Stop-gate (auto-trigger on Stop)     | ✅     | ❌                                |
| Untracked file context               | ✅     | ✅                                |
| Staged vs unstaged separation        | ✅     | Partial (`git diff HEAD` merges) |
| `--scope` working-tree/branch/auto   | ✅     | ✅                                |
| Read-only git permission whitelist   | N/A   | ✅                                |
| Idempotent config registration       | N/A   | ✅                                |
| Partial config merge (`??=` pattern) | N/A   | ✅                                |

---

## Architecture Divergences (intentional)

1. **Subagent vs companion script**: We decided against a custom tool/script for context collection because OpenCode's `!`command`` shell injection + `subtask: true` is cleaner. The subagent handles everything.
2. **No Codex dependency**: We don't need Codex — the subagent IS the reviewer, using OpenCode's model routing.
3. **Permission-based security**: Codex uses server-side `sandbox: "read-only"`. We use OpenCode's permission system. Both achieve the same goal.
4. **No broker**: OpenCode manages model sessions internally.
5. **Stateless**: No job tracking needed — OpenCode's conversation history IS the review history.
