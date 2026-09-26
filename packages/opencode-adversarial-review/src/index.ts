import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { ADVERSARIAL_REVIEWER_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT } from "./prompt.js";

const PLUGIN_ID = "capybearista.opencode-adversarial-review";
// Hex is required; plugin-defined agents do not resolve theme color names.
const REVIEWER_COLOR = "#f59e0b";

type ReviewerConfig = {
  agentId: string;
  commandFilename: string;
  description: string;
  systemPrompt: string;
};

const DO_NOT_INVOKE_DESCRIPTION =
  "Do not invoke this agent directly. It is invocable only by the user.";

// One entry per reviewer. Setup loops both the install and the registration so
// every reviewer shares one set of mechanics and differs only in identity,
// command file, and system prompt.
const REVIEWERS: readonly ReviewerConfig[] = [
  {
    agentId: "adversarial-reviewer",
    commandFilename: "adversarial-review.md",
    description: DO_NOT_INVOKE_DESCRIPTION,
    systemPrompt: ADVERSARIAL_REVIEWER_SYSTEM_PROMPT,
  },
  {
    agentId: "reviewer",
    commandFilename: "review.md",
    description: DO_NOT_INVOKE_DESCRIPTION,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
  },
];

const REVIEWER_AGENT_ID_LIST = REVIEWERS.map((reviewer) => `"${reviewer.agentId}"`).join(" and ");

type PermissionEffect = "allow" | "deny" | "ask";
type PermissionRule = { action: string; resource: string; effect: PermissionEffect };
type AgentEditor = Parameters<Parameters<PluginContext["agent"]["transform"]>[0]>[0];
type AgentInfo = NonNullable<ReturnType<AgentEditor["get"]>>;

// Ordered for the host's last-match-wins evaluation: defaults denied first,
// read-only allows next, and the sensitive-read denies after the read allow.
const REVIEWER_PERMISSIONS: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "write", resource: "*", effect: "deny" },
  { action: "patch", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "skill", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "shell", resource: "git blame*", effect: "allow" },
  { action: "shell", resource: "git branch --show-current*", effect: "allow" },
  { action: "shell", resource: "git diff*", effect: "allow" },
  { action: "shell", resource: "git log*", effect: "allow" },
  { action: "shell", resource: "git ls-files*", effect: "allow" },
  { action: "shell", resource: "git merge-base*", effect: "allow" },
  { action: "shell", resource: "git remote -v*", effect: "allow" },
  { action: "shell", resource: "git rev-list*", effect: "allow" },
  { action: "shell", resource: "git rev-parse*", effect: "allow" },
  { action: "shell", resource: "git show*", effect: "allow" },
  { action: "shell", resource: "git stash list*", effect: "allow" },
  { action: "shell", resource: "git stash show*", effect: "allow" },
  { action: "shell", resource: "git status*", effect: "allow" },
  // `gh` is allowlisted to the read-only PR surface only, plus the
  // `gh auth status*` diagnostic. Order is load-bearing: evaluation is
  // last-match-wins, so the `gh *` catch-all deny must come before the specific
  // allows (after them it would override them), and the specific allows stay
  // ordered most-specific-last. The token-printing forms of the diagnostic are
  // denied after its allow: `--show-token` and its `-t` short form would print
  // the stored credential, while the bare diagnostic stays allowed.
  { action: "shell", resource: "gh *", effect: "deny" },
  { action: "shell", resource: "gh pr view*", effect: "allow" },
  { action: "shell", resource: "gh pr diff*", effect: "allow" },
  { action: "shell", resource: "gh auth status*", effect: "allow" },
  { action: "shell", resource: "gh auth status*--show-token*", effect: "deny" },
  { action: "shell", resource: "gh auth status*-t*", effect: "deny" },
  // Denies below must stay after the allows: `--ext-diff` and `--textconv`
  // execute configured diff drivers, and `--output` writes the rendered diff to
  // an arbitrary file.
  { action: "shell", resource: "git diff*--ext-diff*", effect: "deny" },
  { action: "shell", resource: "git diff*--textconv*", effect: "deny" },
  { action: "shell", resource: "git diff*--output*", effect: "deny" },
  { action: "shell", resource: "git show*--ext-diff*", effect: "deny" },
  { action: "shell", resource: "git show*--textconv*", effect: "deny" },
  { action: "shell", resource: "git show*--output*", effect: "deny" },
  { action: "shell", resource: "git log*--ext-diff*", effect: "deny" },
  { action: "shell", resource: "git log*--textconv*", effect: "deny" },
  { action: "shell", resource: "git log*--output*", effect: "deny" },
  { action: "shell", resource: "git stash show*--ext-diff*", effect: "deny" },
  { action: "shell", resource: "git stash show*--textconv*", effect: "deny" },
  { action: "shell", resource: "git stash show*--output*", effect: "deny" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "glob", resource: "*.env", effect: "deny" },
  { action: "glob", resource: "*.env.*", effect: "deny" },
  { action: "glob", resource: "*.env.example", effect: "allow" },
  { action: "grep", resource: "*.env", effect: "deny" },
  { action: "grep", resource: "*.env.*", effect: "deny" },
  { action: "grep", resource: "*.env.example", effect: "allow" },
];

function hasRule(rules: readonly PermissionRule[], rule: PermissionRule): boolean {
  return rules.some(
    (existing) =>
      existing.action === rule.action &&
      existing.resource === rule.resource &&
      existing.effect === rule.effect,
  );
}

// Rules are merged additively: host-defined rules are preserved, exact
// duplicates are skipped, and pre-existing host denies are re-appended after
// the plugin rules. Evaluation is last-match-wins, so a host deny must outrank
// any plugin allow for the same resource.
function applyRules(agent: AgentInfo, rules: readonly PermissionRule[]): void {
  const inherited = Array.isArray(agent.permissions) ? agent.permissions : [];
  const hostDenies = inherited.filter((rule) => rule.effect === "deny");
  const merged = inherited.filter((rule) => rule.effect !== "deny");
  for (const rule of rules) {
    if (!hasRule(merged, rule) && !hasRule(hostDenies, rule)) merged.push(rule);
  }
  agent.permissions = [...merged, ...hostDenies];
}

function configureReviewerAgent(editor: AgentEditor, reviewer: ReviewerConfig): void {
  const existing = editor.get(reviewer.agentId);
  editor.update(reviewer.agentId, (agent) => {
    agent.mode = "subagent";
    agent.hidden = true;
    agent.description = reviewer.description;
    agent.system = existing?.system ?? reviewer.systemPrompt;
    agent.color = existing?.color ?? REVIEWER_COLOR;
    // The reviewer runs unattended, so inherited ask rules are dropped instead of
    // stalling on a user prompt; the explicit rules below keep it sandboxed.
    const inherited = Array.isArray(agent.permissions) ? agent.permissions : [];
    agent.permissions = inherited.filter((rule) => rule.effect !== "ask");
    applyRules(agent, REVIEWER_PERMISSIONS);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type HostLogSink = (input: {
  service: string;
  level: "error" | "warn";
  message: string;
}) => unknown;

// @opencode/plugin 2.0.2 exposes no logging domain on the plugin context, so
// console.error / console.warn are the fallback. Hosts that add an `app.log` sink
// receive the same messages as structured entries; wording never changes
// between the two paths.
function createHostLogger(ctx: PluginContext, level: "error" | "warn"): (message: string) => void {
  const fallback = level === "error" ? console.error : console.warn;
  const sink = (ctx.app as unknown as { log?: unknown } | undefined)?.log;
  if (typeof sink !== "function") {
    return (message) => fallback(message);
  }
  const hostLog = sink as HostLogSink;
  return (message) => {
    try {
      void Promise.resolve(hostLog.call(ctx.app, { service: PLUGIN_ID, level, message })).catch(
        () => fallback(message),
      );
    } catch {
      fallback(message);
    }
  };
}

function commandFilePath(commandFilename: string): string {
  const configDirectory = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
  return join(configDirectory, "commands", commandFilename);
}

// Write-once: `wx` is atomic, refuses to replace anything already at the path
// (including symlinks), and the plugin never reads or rewrites an existing file.
// Parent-directory trust: the containing `commands/` directory is assumed
// trustworthy. A symlinked parent could redirect the write outside the config
// directory; the no-symlink-following guarantee covers the leaf file only.
async function installCommandFile(
  reviewer: ReviewerConfig,
  logWarn: (message: string) => void,
): Promise<void> {
  const commandPath = commandFilePath(reviewer.commandFilename);
  const commandName = `/${reviewer.commandFilename.replace(/\.md$/, "")}`;
  const assetUrl = new URL(`../commands/${reviewer.commandFilename}`, import.meta.url);
  let template: string;
  try {
    template = await readFile(assetUrl, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read the bundled command template at ${assetUrl.pathname}: ${errorMessage(error)}. Neither reviewer agent was registered.`,
      { cause: error },
    );
  }
  try {
    await writeFile(commandPath, template, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      logWarn(
        `[${PLUGIN_ID}] ${commandPath} already exists; leaving it untouched. It may be stale or customized: edit it in place, delete it to reinstall the bundled template, or delete it after removing the plugin to uninstall.`,
      );
      return;
    }
    throw new Error(
      `Unable to install the ${commandName} command at ${commandPath}: ${errorMessage(error)}. Create the parent directory and grant write access, then restart OpenCode. Neither reviewer agent was registered.`,
      { cause: error },
    );
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const disposers: Array<() => Promise<void> | void> = [];
    const logWarn = createHostLogger(ctx, "warn");

    if (typeof ctx.agent?.transform !== "function") {
      throw new Error(
        `[${PLUGIN_ID}] agent.transform is unavailable; the ${REVIEWER_AGENT_ID_LIST} agents cannot be registered, so setup was aborted`,
      );
    }

    for (const reviewer of REVIEWERS) {
      await installCommandFile(reviewer, logWarn);
    }

    for (const reviewer of REVIEWERS) {
      const registration = await ctx.agent.transform((editor) => {
        configureReviewerAgent(editor, reviewer);
      });
      disposers.push(() => registration.dispose());
    }

    return async () => {
      for (const dispose of disposers) await dispose();
    };
  },
});
