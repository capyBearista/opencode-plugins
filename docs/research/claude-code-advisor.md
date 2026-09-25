# Claude Code Advisor research

**Status:** current  
**Last verified:** 2026-09-25  
**Scope:** Claude Code / Claude Platform Advisor behavior used as the product reference for `opencode-auto-advisor`.

## Question

What behavior should the OpenCode Auto Advisor reproduce from Claude's Advisor, and which details are official versus community-recovered?

## Sources

### Authoritative

- Anthropic Claude Platform Advisor tool documentation: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool

### Community reverse-engineering

- Piebald-AI Claude Code system-prompt extraction repository: https://github.com/Piebald-AI/claude-code-system-prompts
- Extracted Advisor tool instructions: https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/system-prompt-advisor-tool-instructions.md
- asgeirtj system prompt archive, Advisor material: https://github.com/asgeirtj/system_prompts_leaks/tree/main/Anthropic/claude-code/prompts
- Community-recovered Advisor prompt file: https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code/prompts/advisor-tool.md

Community prompt captures are useful corroborating evidence but are not equivalent to Anthropic-published documentation. Exact private wording should therefore not be treated as an authoritative contract.

## Findings

### The explicit tool has no arguments

Anthropic's documented Advisor server-tool call uses an empty input object. The Executor does not pass a question, context summary, or focus field.

The consultation signal is the act of calling the tool; relevant uncertainty or intent already exists in the surrounding transcript.

This supports an OpenCode surface of:

```text
advisor()
```

rather than an API such as `advisor({ question, context })`.

### The Advisor receives the Executor's actual transcript/context

Anthropic documents the Advisor as seeing the working conversation, including the system prompt, tool definitions, prior tool activity, and text already produced in the current turn.

This is a key property, not an incidental implementation choice: the Executor is not asked to decide which evidence to summarize for the reviewer.

The Auto Advisor should therefore make context collection a plugin responsibility.

### Consultation is fresh and independent

The Advisor is a fresh consultation rather than a long-running private reviewer conversation.

The product implication is:

- no persistent private Advisor session;
- no accumulated private Advisor memory between calls;
- every call evaluates the current evidence afresh.

Earlier Advisor guidance may still appear in the parent transcript because the parent conversation persists.

### The Advisor does not need its own tools

Anthropic's documented Advisor performs judgment over the supplied transcript rather than independently exploring the repository.

That differentiates it from a specialist subagent such as an Oracle that may investigate files/tools over multiple turns.

v1 Auto Advisor therefore does not give the Advisor tools.

### Advice returns as a consultation result

For explicit consultation, Claude returns an Advisor tool result and the Executor continues with that result in context.

The result is advice text rather than a required structured JSON decision object.

This supports plain-text Advisor output in Auto Advisor.

### Claude encourages consultation at judgment boundaries

Official documentation and extracted Executor-facing instructions consistently encourage consultation around situations such as:

- before committing to consequential approaches;
- when stuck;
- when changing direction;
- before declaring substantial work complete.

This should inform the Executor-facing tool description, but the OpenCode plugin does not need to reproduce Anthropic's exact private wording.

### Community captures suggest a broad situational-review prompt

The recovered Advisor prompt frames the reviewer as deciding what kind of situation the Executor is in, including patterns equivalent to:

- starting out;
- stuck;
- reviewing work;
- choosing between candidates.

It emphasizes diagnosing the actual trajectory, respecting newer evidence over stale prior advice, avoiding repetition of already-tried approaches, and identifying whether concerns are actually blocking.

This is consistent with the public product behavior and supports a broad second-opinion prompt rather than a narrow code-review persona.

Because the exact Advisor system prompt is not officially published, Auto Advisor should preserve the behavioral intent rather than copy a purported private prompt verbatim.

## Project conclusions

The Auto Advisor explicit path should preserve these invariants:

1. zero-argument `advisor()`;
2. plugin-owned actual-context collection;
3. fresh stateless Advisor inference;
4. no Advisor tools in v1;
5. plain-text independent guidance;
6. genuine tool-result delivery for explicit consultation.

Automatic routing is an OpenCode-specific extension beyond Claude's Executor-self-routed mechanism. It should invoke the same Advisor behavior rather than create a separate automatic-review persona.

## Limitations

- Anthropic can change Claude Code and the server-side Advisor implementation independently of public client releases.
- Community-extracted prompts may be incomplete, version-specific, or obtained through methods that do not establish an official contract.
- Exact prompt wording is intentionally not treated as a stable dependency.

## Related decisions and plan

- [ADR-0001](../decisions/0001-dual-path-auto-advisor.md)
- [Auto Advisor plan](../plans/opencode-auto-advisor.md)
