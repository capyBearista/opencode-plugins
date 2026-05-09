import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN_ID = "capybearista.opencode-adversarial-review";

const ADVERSARIAL_REVIEW_PROMPT = `<role>
You are an adversarial code review agent.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the provided repository context as if you are trying to find the strongest reasons this change should not ship yet.
The user's focus and target arguments are in the message below.

If the arguments include \`--scope auto\`, review using the broadest context the provided information supports (default).
If \`--scope working-tree\`, review staged and unstaged changes against HEAD.
If \`--scope branch\`, collect the diff for all changes on the current branch. Determine the fork point by running \`git merge-base HEAD <upstream>\` where \`<upstream>\` is the tracking branch of HEAD, or \`origin/main\`, or \`main\` (in order of preference). Then run \`git diff <fork>...HEAD\`.
If \`--base <ref>\` is provided without \`--scope\`, treat it as \`--scope branch --base <ref>\`.
If \`--base <ref>\` is provided alongside \`--scope branch\`, use that ref as the base in \`git diff <ref>...HEAD\`.
</task>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
If the user supplied a focus area, weight it heavily, but still report any other material issue you can defend.
If the diff context is limited (only stat, no full diff), use the available tools (read, grep, glob) to inspect specific files before finalizing.
</review_method>

<context_type>
The diff context either contains a full inline diff (for changes to 1-2 files) or a summary stat only (for larger changes). If you see a stat-only section without a full inline diff, use your tools to inspect the changed files directly. If you see a full inline diff, use it as primary evidence and supplement with tools as needed.
</context_type>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<structured_output_contract>
Output valid JSON matching this schema:

{
  "verdict": "approve" | "needs-attention",
  "summary": "terse ship/no-ship assessment",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "short finding title",
      "body": "detailed explanation",
      "file": "relative file path",
      "line_start": 1,
      "line_end": 1,
      "confidence": 0.0-1.0,
      "recommendation": "concrete fix suggestion"
    }
  ],
  "next_steps": ["actionable next step"]
}

Use \`needs-attention\` if there is any material risk worth blocking on.
Use \`approve\` only if you cannot support any substantive adversarial finding from the provided context.
Keep the output compact and specific.
</structured_output_contract>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the provided repository context or tool outputs.
Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly in the finding body and keep the confidence honest.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say so directly and return no findings.
</calibration_rules>

<final_check>
Before finalizing, check that each finding is:
- adversarial rather than stylistic
- tied to a concrete code location
- plausible under a real failure scenario
- actionable for an engineer fixing the issue
</final_check>`;

const COMMAND_TEMPLATE = `## Adversarial Review

Arguments: $ARGUMENTS
Target: code changes

## Git Context

!\`printf "=== Branch ===\\n" && git branch --show-current\`
!\`printf "=== Status ===\\n" && git status --short --untracked-files=all\`
!\`printf "=== Recent Commits ===\\n" && git log --oneline -3\`
!\`printf "=== Changed Files ===\\n" && git diff HEAD --name-only\`
!\`printf "=== Untracked File Contents ===\\n"; git -c core.quotepath=false ls-files --others --exclude-standard | head -5 | while IFS= read -r f; do printf "--- %s ---\\n" "$f" && cat -- "$f" 2>/dev/null | head -c 16384 && printf "\\n"; done\`
!\`FILES=\$(git diff HEAD --name-only | wc -l | tr -d ' '); if [ "\$FILES" -gt 0 ] && [ "\$FILES" -le 5 ]; then printf "=== Full Diff ===\\n" && git diff HEAD; else printf "=== Diff Stat ===\\n" && git diff HEAD --stat; fi\``;

const AGENT_NAME = "adversarial-review";
const CMD_NAME = "adversarial-review";

export const AdversarialReviewPlugin: Plugin = async () => {
  return {
    config: async (cfg) => {
      try {
        cfg.agent ??= {};
        cfg.agent[AGENT_NAME] ??= {};

        const agent = cfg.agent[AGENT_NAME];
        agent.description ??=
          "Adversarial code review — challenges implementation approach and design choices";
        agent.mode ??= "subagent";
        agent.model ??= "openai/gpt-5.4";
        agent.temperature ??= 0.1;
        agent.color ??= "warning";
        (agent as any).permission ??= {};
        const agentPerm = (agent as any).permission;
        agentPerm.edit = "deny";
        agentPerm.bash ??= {
          "git blame*": "allow",
          "git branch": "allow",
          "git diff*": "allow",
          "git log*": "allow",
          "git ls-files*": "allow",
          "git merge-base*": "allow",
          "git rev-list*": "allow",
          "git rev-parse*": "allow",
          "git show*": "allow",
          "git stash list*": "allow",
          "git stash show*": "allow",
          "git status*": "allow",
          "*": "deny",
        };
        agentPerm.read ??= "allow";
        agentPerm.glob ??= "allow";
        agentPerm.grep ??= "allow";
        agentPerm.webfetch ??= "deny";
        agentPerm.websearch ??= "deny";
        agent.prompt ??= ADVERSARIAL_REVIEW_PROMPT;

        cfg.command ??= {};
        cfg.command[CMD_NAME] ??= {} as any;
        const cmd = cfg.command[CMD_NAME] as any;
        cmd.description ??= "Run an adversarial code review that challenges the implementation";
        cmd.argumentHint ??= "[--base <ref>] [--scope auto|working-tree|branch] [focus ...]";
        cmd.agent ??= AGENT_NAME;
        cmd.subtask ??= true;
        cmd.template ??= COMMAND_TEMPLATE;
      } catch (err) {
        console.error(
          `[${PLUGIN_ID}] Failed to register agent and command:`,
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }
    },
  };
};

export default {
  id: PLUGIN_ID,
  server: AdversarialReviewPlugin,
};
