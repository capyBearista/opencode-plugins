import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readFile, unlink, writeFile } from "node:fs/promises";
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
// refreshes the file from the bundled template on `/reload` or restart,
// removing it takes ownership and the file is preserved with a warning.
// Unknown or newer stamps are preserved too, so a downgrade never overwrites a
// newer plugin's file.
export const CURRENT_TEMPLATE_VERSION = 2;
// Every version this build knows how to refresh in place, oldest first.
export const KNOWN_TEMPLATE_VERSIONS: readonly number[] = [1, 2];
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

function doNotInvokeDescription(kind: string): string {
  return `Do not invoke this agent directly. It is the ${kind} code-review agent, invocable only by the user.`;
}

// One entry per reviewer. Setup loops both the install and the registration so
// every reviewer shares one set of mechanics and differs only in identity,
// command file, and system prompt.
const REVIEWERS: readonly ReviewerConfig[] = [
  {
    agentId: "adversarial-reviewer",
    commandFilename: "adversarial-review.md",
    description: doNotInvokeDescription("adversarial"),
    systemPrompt: ADVERSARIAL_REVIEWER_SYSTEM_PROMPT,
  },
  {
    agentId: "constructive-reviewer",
    commandFilename: "constructive-review.md",
    description: doNotInvokeDescription("constructive"),
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
  // `git diff --no-index` reads arbitrary paths and `git show <rev>:<path>`
  // prints a blob directly, bypassing the read/glob/grep `.env` denies. These
  // denies must stay after the `git diff*` / `git show*` allows. Only the
  // colon-path `.env` / `.env.*` leaf forms are covered; other secret files
  // such as `*.pem` remain readable and are a known limitation.
  { action: "shell", resource: "git diff*--no-index*", effect: "deny" },
  { action: "shell", resource: "git show*:*.env", effect: "deny" },
  { action: "shell", resource: "git show*:*.env.*", effect: "deny" },
  // `.env.example` is not secret material, so it stays readable at a revision
  // like it does through read/glob/grep; this allow must stay after the two
  // denies above (last-match-wins).
  { action: "shell", resource: "git show*:*.env.example", effect: "allow" },
  // Order re-assertion: the allow above is full-string anchored, so it also
  // matches any command ending in `.env.example` and overrides every earlier
  // rule that command matches. The `git show` engine-flag denies and the
  // secret-then-more-args denies are therefore repeated after it: the engine
  // patterns must outrank the trailing allow for `git show --output=... /
  // --ext-diff ... <rev>:.env.example`, and the `.env` patterns must catch a
  // secret colon-path followed by any further argument (multi-object exfil and
  // trailing flags such as `git show HEAD:.env --stat`). These duplicates are
  // intentional; the earlier copies sit before the allow and lose to it.
  //
  // Pattern shape notes: the inner `*` in `:*.env` mirrors the original
  // `git show*:*.env` deny so directory-prefixed secrets are covered, not just
  // a leaf at the repository root. The `* *` tail on the `.env.*` deny is
  // deliberate: the host folds a trailing `" .*"` pattern into an optional
  // argument group, so a single trailing ` *` would also match a bare
  // `.env.example` read; the doubled pair makes the following argument required.
  { action: "shell", resource: "git show*--ext-diff*", effect: "deny" },
  { action: "shell", resource: "git show*--textconv*", effect: "deny" },
  { action: "shell", resource: "git show*--output*", effect: "deny" },
  { action: "shell", resource: "git show*:*.env *", effect: "deny" },
  { action: "shell", resource: "git show*:*.env.* * *", effect: "deny" },
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
// duplicates of an inherited host rule are skipped, and pre-existing host
// denies are re-appended after the plugin rules. Evaluation is last-match-wins,
// so a host deny must outrank any plugin allow for the same resource.
// Duplicates inside `rules` itself are kept on purpose: a later copy re-asserts
// a rule that an intermediate allow would otherwise override.
function applyRules(agent: AgentInfo, rules: readonly PermissionRule[]): void {
  const inherited = Array.isArray(agent.permissions) ? agent.permissions : [];
  const hostDenies = inherited.filter((rule) => rule.effect === "deny");
  const merged = inherited.filter((rule) => rule.effect !== "deny");
  for (const rule of rules) {
    if (!hasRule(inherited, rule)) merged.push(rule);
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

async function disposeRegistrations(
  disposers: Array<() => Promise<void> | void>,
  logWarn: (message: string) => void,
): Promise<void> {
  const results = await Promise.allSettled(disposers.map(async (dispose) => dispose()));
  for (const result of results) {
    if (result.status === "rejected") {
      logWarn(
        `[${PLUGIN_ID}] Failed to dispose an agent registration: ${errorMessage(result.reason)}. The host may retain the registration until plugins reload.`,
      );
    }
  }
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
  const override = process.env.OPENCODE_CONFIG_DIR?.trim();
  const configDirectory = override ? override : join(homedir(), ".config", "opencode");
  return join(configDirectory, "commands", commandFilename);
}

export function managedVersionOf(markdown: string): number | undefined {
  const value = frontmatterFieldOf(markdown, "managed_version");
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
  const version = Number(value);
  return version > 0 ? version : undefined;
}

function frontmatterFieldOf(markdown: string, field: string): string | undefined {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block?.[1]) return undefined;
  for (const line of block[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0 || line.slice(0, separator).trim() !== field) continue;
    return line.slice(separator + 1).trim();
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
      `Unable to install the ${commandName} command at ${commandPath}: ${errorMessage(error)}. Create the parent directory and grant write access, then run /reload. Neither reviewer agent was registered.`,
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
  let closeFailure: unknown;
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
    // A close failure must not replace an in-flight read failure; it is
    // captured here and re-raised below only when the read succeeded.
    try {
      await handle?.close();
    } catch (error) {
      closeFailure = error;
    }
  }
  // Fail-closed on purpose: a close failure aborts setup rather than continuing silently.
  if (closeFailure !== undefined) throw installFailure(closeFailure);

  const installedVersion = managedVersionOf(installed);
  if (
    installedVersion === undefined ||
    !isManagedUpgrade(installedVersion, KNOWN_TEMPLATE_VERSIONS, CURRENT_TEMPLATE_VERSION)
  ) {
    warnExistingFile(commandPath, logWarn);
    return;
  }

  // An explicit open separates a failed open (nothing was truncated, so the
  // intact file must survive) from a failed handle write after O_TRUNC has
  // already run (a truncated or partial file must be unlinked so later setups
  // do not preserve it forever). ELOOP can only come from this open; writes to
  // an already-open handle never re-resolve the path.
  const overwrite = await open(commandPath, OVERWRITE_FLAGS).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      warnExistingFile(commandPath, logWarn);
      return undefined;
    }
    throw installFailure(error);
  });
  if (overwrite === undefined) return;
  try {
    await overwrite.writeFile(template);
  } catch (error) {
    // Best-effort unlink returns the path to the fresh `wx` install; on a
    // symlink leaf it removes only the link, never the target.
    await unlink(commandPath).catch(() => {});
    throw installFailure(error);
  } finally {
    // Matching fsPromises.writeFile, a close failure after a successful write
    // is not an install failure.
    await overwrite.close().catch(() => {});
  }
  logInfo(
    `[${PLUGIN_ID}] Updating the managed command file at ${commandPath} from the bundled template (managed_version ${installedVersion}).`,
  );
}

// A pre-rename build installed the second reviewer's command as `review.md`
// with `agent: reviewer`, an id this build no longer registers; the host still
// discovers that leftover as a broken /review command. Only that exact
// filename is inspected, and it is deleted only when it is provably ours: the
// old agent id plus a managed_version stamp this build knows. A missing or
// unknown stamp could be a user's own file, so it is preserved with a loud
// warning naming the file, the broken-command risk, and the manual fix.
const PRE_RENAME_COMMAND_FILENAME = "review.md";
const PRE_RENAME_REVIEWER_AGENT_ID = "reviewer";

async function removeStalePreRenameCommand(
  logWarn: (message: string) => void,
  logInfo: (message: string) => void,
): Promise<void> {
  const stalePath = commandFilePath(PRE_RENAME_COMMAND_FILENAME);
  let contents: string;
  try {
    contents = await readFile(stalePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    logWarn(
      `[${PLUGIN_ID}] Unable to inspect ${stalePath} for a stale pre-rename /review command: ${errorMessage(error)}. If it is not yours, delete it manually so the host stops discovering a broken /review command.`,
    );
    return;
  }
  if (frontmatterFieldOf(contents, "agent") !== PRE_RENAME_REVIEWER_AGENT_ID) return;
  const version = managedVersionOf(contents);
  if (version === undefined || !KNOWN_TEMPLATE_VERSIONS.includes(version)) {
    logWarn(
      `[${PLUGIN_ID}] Found ${stalePath}, a leftover pre-rename /review command for the removed "${PRE_RENAME_REVIEWER_AGENT_ID}" agent without a managed_version stamp this build recognizes; leaving it untouched. That agent no longer exists, so /review is broken: delete that file manually to clear it.`,
    );
    return;
  }
  try {
    await unlink(stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn(
        `[${PLUGIN_ID}] Failed to remove the stale pre-rename command file at ${stalePath}: ${errorMessage(error)}. The "${PRE_RENAME_REVIEWER_AGENT_ID}" agent no longer exists, so /review is broken until you delete that file manually.`,
      );
    }
    return;
  }
  logInfo(
    `[${PLUGIN_ID}] Removed the stale pre-rename command file at ${stalePath} (managed_version ${version}); it registered /review for the removed "${PRE_RENAME_REVIEWER_AGENT_ID}" agent.`,
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

    // Load-bearing split: every command file must install before any agent registers.
    for (const reviewer of REVIEWERS) {
      await installCommandFile(reviewer, logWarn, logInfo);
    }

    await removeStalePreRenameCommand(logWarn, logInfo);

    for (const reviewer of REVIEWERS) {
      try {
        const registration = await ctx.agent.transform((editor) => {
          configureReviewerAgent(editor, reviewer);
        });
        disposers.push(() => registration.dispose());
      } catch (error) {
        // Registration is all-or-nothing: dispose whatever registered before the
        // failure so a failed setup never leaves a half-registered reviewer pair.
        await disposeRegistrations(disposers, logWarn);
        throw error;
      }
    }

    return () => disposeRegistrations(disposers, logWarn);
  },
});
