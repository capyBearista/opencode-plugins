import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { REVIEWER_SYSTEM_PROMPT } from "./prompt.js";

const PLUGIN_ID = "capybearista.opencode-adversarial-review";
const REVIEWER_AGENT_ID = "adversarial-reviewer";
const REVIEW_TEMPERATURE = 0.1;
const COMMAND_FILE_NAME = "adversarial-review.md";
const COMMAND_ASSET_URL = new URL("../commands/adversarial-review.md", import.meta.url);
// Hex is required; plugin-defined agents do not resolve theme color names.
const REVIEWER_COLOR = "#f59e0b";

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
  { action: "shell", resource: "git rev-list*", effect: "allow" },
  { action: "shell", resource: "git rev-parse*", effect: "allow" },
  { action: "shell", resource: "git show*", effect: "allow" },
  { action: "shell", resource: "git stash list*", effect: "allow" },
  { action: "shell", resource: "git stash show*", effect: "allow" },
  { action: "shell", resource: "git status*", effect: "allow" },
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

function configureReviewerAgent(editor: AgentEditor, description: string): void {
  const existing = editor.get(REVIEWER_AGENT_ID);
  editor.update(REVIEWER_AGENT_ID, (agent) => {
    agent.mode = "subagent";
    agent.hidden = true;
    agent.description = description;
    agent.system = existing?.system ?? REVIEWER_SYSTEM_PROMPT;
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

function commandFilePath(): string {
  const configDirectory = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
  return join(configDirectory, "commands", COMMAND_FILE_NAME);
}

function reviewerDescription(commandPath: string): string {
  return `Do not invoke adversarial-reviewer directly. Run /adversarial-review instead; the installed command template at ${commandPath} is the only supported path.`;
}

// Write-once: `wx` is atomic, refuses to replace anything already at the path
// (including symlinks), and the plugin never reads or rewrites an existing file.
// Parent-directory trust: the containing `commands/` directory is assumed
// trustworthy. A symlinked parent could redirect the write outside the config
// directory; the no-symlink-following guarantee covers the leaf file only.
async function installCommandFile(logWarn: (message: string) => void): Promise<string> {
  const commandPath = commandFilePath();
  let template: string;
  try {
    template = await readFile(COMMAND_ASSET_URL, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read the bundled command template at ${COMMAND_ASSET_URL.pathname}: ${errorMessage(error)}. The ${REVIEWER_AGENT_ID} agent was not registered.`,
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
      return commandPath;
    }
    throw new Error(
      `Unable to install the /adversarial-review command at ${commandPath}: ${errorMessage(error)}. Create the parent directory and grant write access, then restart OpenCode; the ${REVIEWER_AGENT_ID} agent was not registered.`,
      { cause: error },
    );
  }
  return commandPath;
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const disposers: Array<() => Promise<void> | void> = [];
    const logError = createHostLogger(ctx, "error");
    const logWarn = createHostLogger(ctx, "warn");

    if (typeof ctx.agent?.transform !== "function") {
      throw new Error(
        `[${PLUGIN_ID}] agent.transform is unavailable; the ${REVIEWER_AGENT_ID} agent cannot be registered, so setup was aborted`,
      );
    }

    const commandPath = await installCommandFile(logWarn);

    const registration = await ctx.agent.transform((editor) => {
      configureReviewerAgent(editor, reviewerDescription(commandPath));
    });
    disposers.push(() => registration.dispose());

    if (typeof ctx.session?.hook === "function") {
      // Session hooks fire for every request in the host, so non-reviewer
      // events are expected. Warn once per observed agent identity to surface
      // skips (including events with no agent at all) without flooding logs.
      const warnedHookAgents = new Set<string>();
      const pinReviewTemperature = (event: {
        sessionID: string;
        agent?: string;
        options: { temperature?: number };
      }) => {
        if (event.agent === REVIEWER_AGENT_ID) {
          event.options.temperature = REVIEW_TEMPERATURE;
          return;
        }
        const observed = event.agent ?? "(missing)";
        if (warnedHookAgents.has(observed)) return;
        warnedHookAgents.add(observed);
        logWarn(
          `[${PLUGIN_ID}] review temperature hook skipped ${event.agent === undefined ? "an event with no agent" : `agent "${event.agent}"`}; temperature is pinned for "${REVIEWER_AGENT_ID}" only`,
        );
      };
      const contextHook = await ctx.session.hook("context", pinReviewTemperature);
      const generateHook = await ctx.session.hook("generate", pinReviewTemperature);
      disposers.push(
        () => contextHook.dispose(),
        () => generateHook.dispose(),
      );
    } else {
      logError(`[${PLUGIN_ID}] session.hook is unavailable; review temperature was not pinned`);
    }

    return async () => {
      for (const dispose of disposers) await dispose();
    };
  },
});
