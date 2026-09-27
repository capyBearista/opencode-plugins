import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { ADVERSARIAL_REVIEWER_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT } from "./prompt.js";

const PLUGIN_ID = "capybearista.opencode-adversarial-review";
// Hex is required; plugin-defined agents do not resolve theme color names.
const REVIEWER_COLOR = "#f59e0b";

// Both command templates version together. The integer `managed_version`
// frontmatter stamp is the ownership marker: keeping it means the plugin
// refreshes the file from the bundled template on restart, removing it takes
// ownership and the file is preserved with a warning. Unknown or newer stamps
// are preserved too, so a downgrade never overwrites a newer plugin's file.
export const CURRENT_TEMPLATE_VERSION = 1;
// Every version this build knows how to refresh in place, oldest first.
export const KNOWN_TEMPLATE_VERSIONS: readonly number[] = [1];
// O_NOFOLLOW closes the lstat-to-read and lstat-to-write races on the refresh
// path: a symlink swapped in after the check makes the next operation fail
// with ELOOP instead of following or truncating the link target. O_CREAT
// tolerates the file disappearing between the EEXIST check and the refresh.
// Platforms without O_NOFOLLOW fall back to the lstat check and setup warns.
const OVERWRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

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

type HostLogLevel = "error" | "warn" | "info";

type HostLogSink = (input: { service: string; level: HostLogLevel; message: string }) => unknown;

// @opencode/plugin 2.0.2 exposes no logging domain on the plugin context, so
// console.error / console.warn / console.info are the fallback. Hosts that add
// an `app.log` sink receive the same messages as structured entries; wording
// never changes between the two paths. The fallback console method is captured
// once per createHostLogger call, so replace console methods before setup.
function createHostLogger(ctx: PluginContext, level: HostLogLevel): (message: string) => void {
  const fallbacks: Record<HostLogLevel, (...args: unknown[]) => void> = {
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  const fallback = fallbacks[level];
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

export function managedVersionOf(markdown: string): number | undefined {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block?.[1]) return undefined;
  for (const line of block[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0 || line.slice(0, separator).trim() !== "managed_version") continue;
    const value = line.slice(separator + 1).trim();
    if (!/^[0-9]+$/.test(value)) return undefined;
    const version = Number(value);
    return version > 0 ? version : undefined;
  }
  return undefined;
}

export function isManagedUpgrade(
  installedVersion: number,
  knownVersions: readonly number[],
  currentVersion: number,
): boolean {
  return knownVersions.includes(installedVersion) && installedVersion <= currentVersion;
}

// On platforms without `constants.O_NOFOLLOW` (for example Windows) the refresh
// read and write keep the earlier `lstat` check but cannot close the symlink
// swap race around it. Surface the degradation once instead of failing loud.
function warnIfNoFollowUnavailable(
  logWarn: (message: string) => void,
  noFollowFlag: number | undefined,
): void {
  if (noFollowFlag === undefined) {
    logWarn(
      `[${PLUGIN_ID}] O_NOFOLLOW is unavailable on this platform; managed command file refreshes keep the lstat check on the leaf file but cannot close the symlink-swap race around it.`,
    );
  }
}

function warnExistingFile(commandPath: string, logWarn: (message: string) => void): void {
  logWarn(
    `[${PLUGIN_ID}] ${commandPath} already exists; leaving it untouched. It may be stale or customized: edit it in place, delete it to reinstall the bundled template, or delete it after removing the plugin to uninstall.`,
  );
}

// `wx` makes the first write atomic and refuses to replace anything already at
// the path; the EEXIST path decides between a managed refresh (a known
// `managed_version` stamp no newer than the shipped template) and a preserve-
// and-warn for user-owned, unknown, or newer content. Parent-directory trust:
// the containing `commands/` directory is assumed trustworthy. A symlinked
// parent could redirect the write outside the config directory; the
// no-symlink-following guarantee covers the leaf file only.
async function installCommandFile(
  reviewer: ReviewerConfig,
  logWarn: (message: string) => void,
  logInfo: (message: string) => void,
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
  const installFailure = (error: unknown): Error =>
    new Error(
      `Unable to install the ${commandName} command at ${commandPath}: ${errorMessage(error)}. Create the parent directory and grant write access, then restart OpenCode. Neither reviewer agent was registered.`,
      { cause: error },
    );

  try {
    await writeFile(commandPath, template, { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw installFailure(error);
  }

  // lstat, not stat: a symlinked leaf is never followed, read, or truncated.
  const stats = await lstat(commandPath).catch((error: unknown) => {
    throw installFailure(error);
  });
  if (stats.isSymbolicLink()) {
    warnExistingFile(commandPath, logWarn);
    return;
  }

  // `open`, not `readFile`: READ_FLAGS carries O_NOFOLLOW so the symlink check
  // is atomic with the read. ELOOP means a symlink was swapped in after lstat.
  let handle: FileHandle | undefined;
  let installed: string;
  try {
    handle = await open(commandPath, READ_FLAGS);
    installed = await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      warnExistingFile(commandPath, logWarn);
      return;
    }
    throw installFailure(error);
  } finally {
    await handle?.close();
  }

  const installedVersion = managedVersionOf(installed);
  if (
    installedVersion === undefined ||
    !isManagedUpgrade(installedVersion, KNOWN_TEMPLATE_VERSIONS, CURRENT_TEMPLATE_VERSION)
  ) {
    warnExistingFile(commandPath, logWarn);
    return;
  }

  try {
    await writeFile(commandPath, template, { flag: OVERWRITE_FLAGS });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      warnExistingFile(commandPath, logWarn);
      return;
    }
    throw installFailure(error);
  }
  logInfo(
    `[${PLUGIN_ID}] Updating the managed command file at ${commandPath} from the bundled template (managed_version ${installedVersion}).`,
  );
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const disposers: Array<() => Promise<void> | void> = [];
    const logWarn = createHostLogger(ctx, "warn");
    const logInfo = createHostLogger(ctx, "info");

    if (typeof ctx.agent?.transform !== "function") {
      throw new Error(
        `[${PLUGIN_ID}] agent.transform is unavailable; the ${REVIEWER_AGENT_ID_LIST} agents cannot be registered, so setup was aborted`,
      );
    }

    warnIfNoFollowUnavailable(logWarn, constants.O_NOFOLLOW);

    for (const reviewer of REVIEWERS) {
      await installCommandFile(reviewer, logWarn, logInfo);
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
