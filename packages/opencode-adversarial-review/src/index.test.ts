import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import plugin, {
  CURRENT_TEMPLATE_VERSION,
  isManagedUpgrade,
  KNOWN_TEMPLATE_VERSIONS,
  managedVersionOf,
} from "./index.js";

type TestPermission = { action: string; resource: string; effect: string };

type TestAgent = {
  id: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
  system?: string;
  color?: string;
  model?: string;
  temperature?: number;
  permissions?: TestPermission[];
};

type HookEvent = { sessionID: string; agent?: string; options: { temperature?: number } };

type TestLogEntry = { service: string; level: string; message: string };

type TestHostLog = (input: Record<string, unknown>) => unknown;

const PLUGIN_ID = "capybearista.opencode-adversarial-review";
const PACKAGE_NAME = "@capybearista/opencode-adversarial-review";
const REVIEWER_AGENT_ID = "adversarial-reviewer";
const COMMAND_FILE_NAME = "adversarial-review.md";
const COMMAND_ASSET_PATH = join(import.meta.dirname, "..", "commands", COMMAND_FILE_NAME);
const CONSTRUCTIVE_REVIEW_AGENT_ID = "constructive-reviewer";
const CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME = "constructive-review.md";
const CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH = join(
  import.meta.dirname,
  "..",
  "commands",
  CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME,
);
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const JSON_VERBATIM_RULE =
  "Return only valid JSON, verbatim. Do not wrap the JSON in markdown fences or add commentary outside the JSON object.";
const MARKDOWN_VERBATIM_RULE =
  "Return only the Markdown report, verbatim. Do not wrap the report in markdown fences or add commentary outside the report.";
const ADVERSARIAL_REVIEWER_DESCRIPTION =
  "Do not invoke this agent directly. It is the adversarial code-review agent, invocable only by the user.";
const CONSTRUCTIVE_REVIEWER_DESCRIPTION =
  "Do not invoke this agent directly. It is the constructive code-review agent, invocable only by the user.";
const MANAGED_VERSION_FIELD = "managed_version";
const CURRENT_MANAGED_VERSION = "2";
// The pre-rename build installed the second reviewer's command as review.md
// with `agent: reviewer`, an id this build no longer registers. The host still
// discovers that leftover as a broken /review command.
const STALE_REVIEW_COMMAND_FILE_NAME = "review.md";
const PRE_RENAME_REVIEWER_AGENT_ID = "reviewer";

// The managed_version stamp and the ownership metadata wording are the only
// frontmatter additions the packaged templates may carry; every other key must
// stay in this allowlist.
const COMMAND_FRONTMATTER_KEYS = [
  "description",
  "agent",
  "subagent",
  "metadata",
  MANAGED_VERSION_FIELD,
] as const;

// The shared deterministic resolver block is byte-identical across both
// prompts and both prompt references; only the remainder sentence (focus area
// vs. ignored) differs by reviewer. The command templates must not restate it:
// MOVED_DOCTRINE_PHRASES pins those rules to the prompts.
const RESOLVER_HEAD = `Target selection:
- A pull request URL always wins: when an argument is a PR URL, that URL selects the PR, no matter where it appears or what other target tokens are present.
- Otherwise, the first bare token decides: an all-decimal number is a PR number, and a hex string of 7 or more characters containing at least one letter a-f, or any full-length 40-character SHA, is a commit. A pure-decimal string is never a commit, so \`1234567\` is PR #1234567.
- A first bare token that matches neither class (including non-hex non-decimal tokens) is reported plainly as unresolvable and never scope-reviewed; hex matching is case-insensitive (A-F accepted), a 40-character all-decimal token is read as a commit SHA because the length rule wins over the decimal rule, and multiple PR URLs resolve first-URL-wins with the remainder reported, not reviewed.
- An explicit target (PR URL, PR number, or commit SHA) beats \`--scope\` and \`--base\`: when one is present, those flags are ignored.`;

const RESOLVER_REMAINDER_ADVERSARIAL =
  "- The first target token wins; any remaining trailing text is the focus area.";

const RESOLVER_REMAINDER_REVIEW =
  "- The first target token wins. Other trailing non-flag text is ignored; focus areas are not supported, so review the whole change the selected target covers.";

const RESOLVER_TAIL = `- Before resolving a bare PR number, verify the current repository with \`git remote -v\`; a bare number is resolved in the current repository only, and any \`user:token@\` credentials in the remote output are redacted before you reason about it.
- Resolve PR URLs against the current repository only: if a URL points at another repository, stop and warn explicitly unless the user asked for a cross-repo review.
- A commit target is reviewed with \`git show <sha>\` yourself, and files at that revision are read with \`git show <sha>:<file>\` instead of their working-tree copies.
- A pull request target is reviewed with \`gh pr view <pr-or-url>\` and \`gh pr diff <pr-or-url>\` yourself. If \`gh\` is missing or unauthenticated, report that plainly instead of guessing at the change; when \`gh\` fails, report its stderr verbatim.
- For a commit or pull request target, prefer the evidence you collect yourself over the working-tree snapshot blocks: they describe the current checkout, not the selected target.
- Otherwise, select the review scope with the flags below.`;

function expectDeterministicResolver(text: string, remainder: string): void {
  expect(text).toInclude(`${RESOLVER_HEAD}\n${remainder}\n${RESOLVER_TAIL}\n`);
}

// Normative rules moved out of the command templates: target selection, focus
// handling, fork-point resolution, evidence gating, and output wording now
// live only in the system prompts (src/prompt.ts plus its references).
//
// The command pointers paraphrase those rules on purpose so they never reuse a
// banned substring and trip this tripwire; a local orientation that reuses one
// fails CI intentionally and requires a deliberate update here rather than
// silent wording drift.
const MOVED_DOCTRINE_PHRASES = [
  "Target selection:",
  "A pull request URL always wins",
  "the first bare token decides",
  "reported plainly as unresolvable",
  "beats `--scope` and `--base`",
  "The first target token wins",
  "any remaining trailing text is the focus area",
  "focus areas are not supported",
  "verify the current repository with `git remote -v`",
  "stop and warn explicitly unless the user asked for a cross-repo review",
  "when `gh` fails, report its stderr verbatim",
  "prefer the evidence you collect yourself over the working-tree snapshot blocks",
  "If `--scope auto` (the default)",
  "If `--scope working-tree`",
  "If `--scope branch`",
  "git merge-base HEAD <upstream>",
];

// The platform-scope note is neither doctrine nor instruction-path content:
// it was removed from the command templates entirely. The reviewer side
// (read/glob/grep/git through the host tool abstraction) is portable; only the
// five snapshot blocks are shell-dependent, and they degrade via `|| true`
// while the snapshot caveat tells the reviewer to self-collect. Any
// reintroduction of the old scope wording is a regression this tripwire
// catches.
const REMOVED_PLATFORM_SCOPE_PHRASES = [
  "Platform scope:",
  "GNU/Linux",
  "Bash-compatible shell",
  "No Windows or macOS parity is claimed",
];

const REVIEW_ONLY_GUARDRAIL =
  "Review only: do not modify the repository; report findings and suggestions for the author to apply.";
const REVIEW_ONLY_TRIPWIRE_STEM = "Review only: do not modify the repository";

// Guardrail vs doctrine: the review-only sentence is a read-only safety
// constraint on the reviewer, not review doctrine, so it is the one exception
// to the doctrine-free template rule. constructive-review.md carries the full sentence and
// passes via this allowlist; the banned stem still fails for
// adversarial-review.md and every other asset.
const DOCTRINE_TRIPWIRE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  [CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME]: [REVIEW_ONLY_GUARDRAIL],
};
const TEMPLATE_TRIPWIRE_PHRASES = [
  ...MOVED_DOCTRINE_PHRASES,
  ...REMOVED_PLATFORM_SCOPE_PHRASES,
  REVIEW_ONLY_TRIPWIRE_STEM,
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function isolatedConfigDirectory(): Promise<string> {
  const directory = await temporaryDirectory("adversarial-review-config-");
  await mkdir(join(directory, "commands"), { recursive: true });
  return directory;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push(relative(root, full));
    }
  }
  await visit(root);
  return files.sort();
}

function frontmatterOf(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) throw new Error("command asset has no frontmatter block");
  const entries: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) entries[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return entries;
}

type TestContextInput = {
  agents?: TestAgent[];
  hostLog?: TestHostLog;
  failFirstAgentDispose?: boolean;
  failSecondAgentTransform?: boolean;
};

function createTestContext(input: TestContextInput = {}) {
  const agents = new Map<string, TestAgent>(
    (input.agents ?? []).map((agent) => [
      agent.id,
      { permissions: [{ action: "*", resource: "*", effect: "allow" }], ...agent },
    ]),
  );
  const hooks = new Map<string, (event: HookEvent) => void>();
  const disposers: string[] = [];
  let agentTransforms = 0;
  const commandTransforms: number[] = [];
  const logs: TestLogEntry[] = [];
  const hostLog =
    input.hostLog ??
    ((entry: Record<string, unknown>) => {
      logs.push(entry as TestLogEntry);
    });

  const editor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    update: (id: string, update: (agent: TestAgent) => void) => {
      let agent = agents.get(id);
      if (!agent) {
        agent = { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
        agents.set(id, agent);
      }
      update(agent);
    },
    remove: (id: string) => agents.delete(id),
    default: () => {},
  };

  const ctx = {
    app: {
      name: "opencode",
      version: "test",
      channel: "test",
      log: hostLog,
    },
    agent: {
      transform: async (callback: (value: typeof editor) => void) => {
        agentTransforms += 1;
        const transformIndex = agentTransforms;
        if (input.failSecondAgentTransform && transformIndex === 2) {
          throw new Error("second agent transform failed");
        }
        callback(editor);
        return {
          dispose: async () => {
            if (input.failFirstAgentDispose && transformIndex === 1) {
              throw new Error("first agent dispose failed");
            }
            disposers.push("agent");
          },
        };
      },
    },
    session: {
      hook: async (name: string, callback: (event: HookEvent) => void) => {
        hooks.set(name, callback);
        return {
          dispose: async () => {
            disposers.push(`hook:${name}`);
          },
        };
      },
    },
    command: {
      transform: async () => {
        commandTransforms.push(1);
        return {
          dispose: async () => {
            disposers.push("command");
          },
        };
      },
    },
  };

  return { ctx, agents, hooks, disposers, commandTransforms, logs, configDir: "" };
}

type TestContext = ReturnType<typeof createTestContext>;

async function setupPlugin(context: TestContext, configDir?: string) {
  context.configDir = configDir ?? (await isolatedConfigDirectory());
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = context.configDir;
  try {
    return await plugin.setup(context.ctx as never);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
}

type SubprocessSetup = {
  ok: boolean;
  error?: string;
  agents: Array<{
    id: string;
    mode?: string;
    hidden?: boolean;
    description?: string;
    color?: string;
  }>;
  hooks: string[];
  commandTransforms: number;
  logs: TestLogEntry[];
};

function childEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "OPENCODE_CONFIG_DIR") environment[key] = value;
  }
  return { ...environment, ...overrides };
}

function fsErrorMock(
  method: "readFile" | "writeFile",
  error: { code: string; message: string; onlyFor?: string } | undefined,
): string {
  if (error === undefined) return "";
  const real = method === "readFile" ? "realReadFile" : "realWriteFile";
  const guard =
    error.onlyFor === undefined
      ? ""
      : `if (!String(path).endsWith(${JSON.stringify(`/${error.onlyFor}`)})) {
          return ${real}(path, ...args);
        }
        `;
  return `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const ${real} = fs.${method}.bind(fs);
    mock.module("node:fs/promises", () => ({
      ...fs,
      ${method}: async (path, ...args) => {
        ${guard}const error = new Error(${JSON.stringify(error.message)});
        error.code = ${JSON.stringify(error.code)};
        throw error;
      },
    }));
  `;
}

// Fails the refresh write after its O_TRUNC open succeeded: the real open runs
// first, truncating the file exactly as O_TRUNC does, then the returned
// handle's write fails. Models the partial-write failure whose stranded file
// must be unlinked so the next setup takes the fresh `wx` path.
function refreshWriteErrorMock(error: { code: string; message: string } | undefined): string {
  if (error === undefined) return "";
  return `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const refreshConstants = (await import("node:fs")).constants;
    const realRefreshOpen = fs.open.bind(fs);
    mock.module("node:fs/promises", () => ({
      ...fs,
      open: async (path, ...args) => {
        const flags = args[0];
        const handle = await realRefreshOpen(path, ...args);
        if (typeof flags !== "number" || (flags & refreshConstants.O_TRUNC) === 0) return handle;
        return {
          writeFile: async () => {
            const error = new Error(${JSON.stringify(error.message)});
            error.code = ${JSON.stringify(error.code)};
            throw error;
          },
          close: () => handle.close(),
        };
      },
    }));
  `;
}

// Models the lstat-to-read race: `lstat` reports the leaf as a regular file
// even while a symlink is present, so only the O_NOFOLLOW read can catch the
// swap.
function lstatReportsRegularFileMock(fileName: string | undefined): string {
  if (fileName === undefined) return "";
  return `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const realLstat = fs.lstat.bind(fs);
    mock.module("node:fs/promises", () => ({
      ...fs,
      lstat: async (path, ...args) => {
        if (String(path).endsWith(${JSON.stringify(`/${fileName}`)})) {
          return { isSymbolicLink: () => false };
        }
        return realLstat(path, ...args);
      },
    }));
  `;
}

// Deletes the leaf right after its content is read, modeling the file
// disappearing between the ownership check and the refresh write. Only read
// opens are wrapped: the refresh's O_TRUNC open must keep its real handle and
// recreate the path it finds missing.
function deleteOnReadMock(fileName: string | undefined): string {
  if (fileName === undefined) return "";
  return `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const deleteOnReadConstants = (await import("node:fs")).constants;
    const realOpen = fs.open.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    mock.module("node:fs/promises", () => ({
      ...fs,
      open: async (path, ...args) => {
        const flags = args[0];
        const handle = await realOpen(path, ...args);
        const isReadOpen =
          typeof flags === "number" &&
          (flags & (deleteOnReadConstants.O_WRONLY | deleteOnReadConstants.O_RDWR)) === 0;
        if (!isReadOpen || !String(path).endsWith(${JSON.stringify(`/${fileName}`)})) return handle;
        return {
          readFile: async (...readArgs) => {
            const contents = await handle.readFile(...readArgs);
            await realUnlink(path);
            return contents;
          },
          close: () => handle.close(),
        };
      },
    }));
  `;
}

// Models a read failure followed by a close failure: the close error must not
// mask the read error the install path has to report.
function failReadAndCloseMock(fileName: string | undefined): string {
  if (fileName === undefined) return "";
  return `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const realOpen = fs.open.bind(fs);
    mock.module("node:fs/promises", () => ({
      ...fs,
      open: async (path, ...args) => {
        if (!String(path).endsWith(${JSON.stringify(`/${fileName}`)})) return realOpen(path, ...args);
        return {
          readFile: async () => {
            const error = new Error("EACCES: permission denied, read");
            error.code = "EACCES";
            throw error;
          },
          close: async () => {
            throw new Error("close failed after read error");
          },
        };
      },
    }));
  `;
}

// Removes O_NOFOLLOW from the fs constants, modeling a platform (for example
// Windows) where the symlink-race guard is unavailable.
function missingNoFollowMock(enabled: boolean | undefined): string {
  if (!enabled) return "";
  return `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs");
    mock.module("node:fs", () => ({
      ...fs,
      constants: { ...fs.constants, O_NOFOLLOW: undefined },
    }));
  `;
}

type SetupSubprocessConfiguration = {
  home: string;
  opencodeConfigDir?: string;
  readFileError?: { code: string; message: string; onlyFor?: string };
  writeFileError?: { code: string; message: string; onlyFor?: string };
  refreshWriteError?: { code: string; message: string };
  maskLstatFor?: string;
  deleteOnRead?: string;
  failReadAndClose?: string;
  noFollowUnavailable?: boolean;
};

async function runSetupInSubprocess(
  configuration: SetupSubprocessConfiguration,
): Promise<SubprocessSetup> {
  const pluginURL = pathToFileURL(join(PACKAGE_ROOT, "src", "index.ts")).href;
  const writeFileMock = fsErrorMock("writeFile", configuration.writeFileError);
  const refreshWriteMock = refreshWriteErrorMock(configuration.refreshWriteError);
  const readFileMock = fsErrorMock("readFile", configuration.readFileError);
  const lstatMock = lstatReportsRegularFileMock(configuration.maskLstatFor);
  const openMock = deleteOnReadMock(configuration.deleteOnRead);
  const readAndCloseMock = failReadAndCloseMock(configuration.failReadAndClose);
  const noFollowMock = missingNoFollowMock(configuration.noFollowUnavailable);
  const script = `
    ${writeFileMock}
    ${refreshWriteMock}
    ${readFileMock}
    ${lstatMock}
    ${openMock}
    ${readAndCloseMock}
    ${noFollowMock}
    const { default: plugin } = await import(${JSON.stringify(pluginURL)});
    const agents = [];
    const hooks = [];
    const logs = [];
    let commandTransforms = 0;
    const ctx = {
      app: {
        name: "test",
        version: "test",
        channel: "test",
        log: (entry) => { logs.push(entry); },
      },
      agent: {
        transform: async (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            update: (id, update) => {
              const agent = { id, permissions: [] };
              update(agent);
              agents.push({
                id: agent.id,
                mode: agent.mode,
                hidden: agent.hidden,
                description: agent.description,
                color: agent.color,
              });
            },
            remove: () => {},
            default: () => {},
          });
          return { dispose: async () => {} };
        },
      },
      session: {
        hook: async (name) => {
          hooks.push(name);
          return { dispose: async () => {} };
        },
      },
      command: {
        transform: async () => {
          commandTransforms += 1;
          return { dispose: async () => {} };
        },
      },
    };
    let error;
    try {
      const cleanup = await plugin.setup(ctx);
      if (typeof cleanup === "function") await cleanup();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    console.log(JSON.stringify({ ok: error === undefined, error, agents, hooks, commandTransforms, logs }));
  `;
  const child = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    cwd: PACKAGE_ROOT,
    env: childEnvironment({
      HOME: configuration.home,
      ...(configuration.opencodeConfigDir === undefined
        ? {}
        : { OPENCODE_CONFIG_DIR: configuration.opencodeConfigDir }),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(child.stderr));
  }
  const stdout = new TextDecoder().decode(child.stdout).trim();
  const payload = stdout.split("\n").at(-1) ?? "";
  return JSON.parse(payload) as SubprocessSetup;
}

// Local approximation of host enforcement, mirroring `Wildcard.match` from
// @opencode/core (`*` -> `.*`, `?` -> `.`, trailing `" .*"` accepts an optional
// space-suffixed argument) plus `Permission.evaluate`'s last-match-wins scan.
// The host is authoritative at runtime; keep this matcher minimal and do not
// extend it beyond the semantics the reviewer rule set relies on.
function wildcardMatch(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
}

function effectiveEffect(
  permissions: readonly TestPermission[],
  action: string,
  resource: string,
): string {
  for (let index = permissions.length - 1; index >= 0; index -= 1) {
    const rule = permissions[index];
    if (rule && wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
      return rule.effect;
    }
  }
  return "ask";
}

describe("@capybearista/opencode-adversarial-review", () => {
  test("exports a V2 plugin definition with the package id", () => {
    expect(plugin).toBeObject();
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(plugin.setup).toBeFunction();
    expect("server" in plugin).toBe(false);
    expect("tui" in plugin).toBe(false);
  });

  test("package.json targets the V2 package root, ships the command, and has no TUI metadata", async () => {
    const manifest = await Bun.file(join(PACKAGE_ROOT, "package.json")).json();
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.description).toInclude("adversarial reviewer");
    expect(manifest.description).toInclude("constructive reviewer");
    expect(manifest.exports["."].default).toBe("./dist/index.js");
    expect(manifest.files).toContain("server.js");
    expect(manifest.files).toContain("commands");
    expect(manifest.scripts.build).not.toInclude("check-schema-asset");
    expect(manifest.peerDependencies["@opencode/plugin"]).toBeString();
    expect(manifest.devDependencies["@opencode/plugin"]).toBeString();
    expect("oc-plugin" in manifest).toBe(false);
  });

  test("real V2 host resolves the package root server wrapper to the built entry", () => {
    const child = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `
          import * as Host from "@opencode/plugin/host";
          const root = ${JSON.stringify(PACKAGE_ROOT)};
          const local = Host.resolve({ directory: root });
          const named = Host.resolve({ directory: root, name: ${JSON.stringify(PACKAGE_NAME)} });
          process.stdout.write(JSON.stringify({
            local: { server: local.server ?? null, tui: local.tui ?? null, rpc: local.rpc ?? null },
            named: { server: named.server ?? null, tui: named.tui ?? null, rpc: named.rpc ?? null },
          }));
        `,
      ],
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr));
    }

    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
      local: {
        server: pathToFileURL(join(PACKAGE_ROOT, "server.js")).href,
        tui: null,
        rpc: null,
      },
      named: {
        server: pathToFileURL(join(PACKAGE_ROOT, "dist", "index.js")).href,
        tui: null,
        rpc: null,
      },
    });
  });

  test("setup registers the reviewer agent without registering a host command", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.commandTransforms).toHaveLength(0);
    await cleanup?.();
  });

  test("reviewer agent runs as a hidden subagent", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const agent = context.agents.get(REVIEWER_AGENT_ID);
    expect(agent?.mode).toBe("subagent");
    expect(agent?.hidden).toBe(true);
  });

  test("both reviewers run as hidden subagents with do-not-invoke descriptions", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const expected = [
      [REVIEWER_AGENT_ID, ADVERSARIAL_REVIEWER_DESCRIPTION],
      [CONSTRUCTIVE_REVIEW_AGENT_ID, CONSTRUCTIVE_REVIEWER_DESCRIPTION],
    ] as const;
    for (const [agentId, description] of expected) {
      const agent = context.agents.get(agentId);
      expect(agent?.mode).toBe("subagent");
      expect(agent?.hidden).toBe(true);
      expect(agent?.description).toBe(description);
    }
  });

  test("adversarial reviewer description names its do-not-invoke role", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect(context.agents.get(REVIEWER_AGENT_ID)?.description).toBe(
      ADVERSARIAL_REVIEWER_DESCRIPTION,
    );
  });

  test("constructive reviewer description names its do-not-invoke role", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect(context.agents.get(CONSTRUCTIVE_REVIEW_AGENT_ID)?.description).toBe(
      CONSTRUCTIVE_REVIEWER_DESCRIPTION,
    );
  });

  test("existing reviewer configuration keeps system and color but not its description", async () => {
    const context = createTestContext({
      agents: [
        {
          id: REVIEWER_AGENT_ID,
          mode: "primary",
          description: "custom description",
          system: "custom system",
          color: "#123456",
        },
      ],
    });
    await setupPlugin(context);

    const agent = context.agents.get(REVIEWER_AGENT_ID);
    expect(agent?.description).not.toBe("custom description");
    expect(agent?.description).toBe(ADVERSARIAL_REVIEWER_DESCRIPTION);
    expect(agent?.system).toBe("custom system");
    expect(agent?.color).toBe("#123456");
    expect(agent?.mode).toBe("subagent");
    expect(agent?.hidden).toBe(true);
  });

  test("existing review agent configuration keeps system and color but not its description", async () => {
    const context = createTestContext({
      agents: [
        {
          id: CONSTRUCTIVE_REVIEW_AGENT_ID,
          mode: "primary",
          description: "custom description",
          system: "custom system",
          color: "#654321",
        },
      ],
    });
    await setupPlugin(context);

    const agent = context.agents.get(CONSTRUCTIVE_REVIEW_AGENT_ID);
    expect(agent?.description).not.toBe("custom description");
    expect(agent?.description).toBe(CONSTRUCTIVE_REVIEWER_DESCRIPTION);
    expect(agent?.system).toBe("custom system");
    expect(agent?.color).toBe("#654321");
    expect(agent?.mode).toBe("subagent");
    expect(agent?.hidden).toBe(true);
  });

  test("reviewer agent keeps the evidence-first system prompt and the verbatim JSON rule", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const reference = await Bun.file(
      join(import.meta.dirname, "prompts", "adversarial-review.md"),
    ).text();
    const system = context.agents.get(REVIEWER_AGENT_ID)?.system ?? "";

    expect(system).toBe(`${reference.trimEnd()}\n\n${JSON_VERBATIM_RULE}`);
    expect(system).toInclude("Collect your own evidence with the read-only tools");
    expect(system).toInclude("never use `echo`");
    expect(system).toInclude("Treat that snapshot as a starting point, not as a complete record");
    expect(system).toInclude("<attack_surface>");
    expect(system).toInclude("<finding_bar>");
    expect(system).toInclude("<structured_output_contract>");
    expect(system).toInclude("If `--scope auto` (the default)");
    expect(system).toInclude("review the working tree when it has staged or unstaged changes");
    expect(system).toInclude(
      "still read untracked files from the working tree because they never appear in the branch diff",
    );
    expectDeterministicResolver(system, RESOLVER_REMAINDER_ADVERSARIAL);
    expect(system).toInclude("A pull request URL always wins");
    expect(system).toInclude("an all-decimal number is a PR number");
    expect(system).toInclude(
      "A pure-decimal string is never a commit, so `1234567` is PR #1234567",
    );
    expect(system).toInclude("reported plainly as unresolvable and never scope-reviewed");
    expect(system).toInclude("hex matching is case-insensitive (A-F accepted)");
    expect(system).toInclude(
      "a 40-character all-decimal token is read as a commit SHA because the length rule wins over the decimal rule",
    );
    expect(system).toInclude(
      "multiple PR URLs resolve first-URL-wins with the remainder reported, not reviewed",
    );
    expect(system).toInclude("beats `--scope` and `--base`");
    expect(system).toInclude("verify the current repository with `git remote -v`");
    expect(system).toInclude(
      "any `user:token@` credentials in the remote output are redacted before you reason about it",
    );
    expect(system).toInclude(
      "stop and warn explicitly unless the user asked for a cross-repo review",
    );
    expect(system).toInclude("when `gh` fails, report its stderr verbatim");
    expect(system).toInclude("Gate evidence collection on the selected target");
    expect(system).toInclude(
      "Commit target: use only `git show <sha>` and `git show <sha>:<file>` for versioned files",
    );
    expect(system).toInclude("Do not read, grep, or glob working-tree copies");
    expect(system).toInclude(
      "if the commit is not available locally, report that plainly instead of guessing",
    );
    expect(system).toInclude("Pull request target: collect `gh` evidence first");
    expect(system).toInclude("verifying it matches the PR head revision");
    expect(system).toInclude("run `git status --short -- <file>` before reading that file");
    expect(system).toInclude("a dirty working-tree copy is not the PR revision");
    expect(system).toInclude("resolve the PR head with `gh pr view <pr-or-url> --json headRefOid`");
    expect(system).toInclude("compare it with `git rev-parse HEAD`");
    expect(system).toInclude(
      "when either value is unavailable, report that plainly and fall back to `gh` evidence",
    );
    expect(system).toInclude(
      "prefer the evidence you collect yourself over the working-tree snapshot blocks",
    );
    expect(system).toInclude("`git merge-base`, `git remote -v`, `git rev-list`");
    expect(system).toInclude(
      "and the read-only `gh pr view` / `gh pr diff` for a pull request target plus the `gh auth status` diagnostic",
    );
    expect(system).not.toInclude(
      "A bare commit SHA (full 40-character or short form) selects that commit",
    );
    expect(system).not.toInclude(
      "A bare all-decimal number is a PR number, a bare hex string of 7 or more characters",
    );
    expect(system).not.toInclude("The first bare SHA, PR-number, or URL token selects the target");
    expect(system).not.toInclude("The inline Git context is primary evidence");
    expect(system).not.toInclude("full text bodies of unignored untracked files");
  });

  test("the review agent keeps the constructive review prompt and the verbatim markdown rule", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const reference = await Bun.file(
      join(import.meta.dirname, "prompts", "constructive-review.md"),
    ).text();
    const system = context.agents.get(CONSTRUCTIVE_REVIEW_AGENT_ID)?.system ?? "";

    expect(system).toBe(`${reference.trimEnd()}\n\n${MARKDOWN_VERBATIM_RULE}`);
    expect(system).toInclude("Review only: do not modify the repository");
    expect(system).toInclude("Other trailing non-flag text is ignored");
    expect(system).toInclude("state `None` when the change is sound");
    expect(system).toInclude(
      "each tagged `must` when it warrants action or should block, or `consider` when it is optional",
    );
    expect(system).not.toInclude("acknowledged");
    expect(system).toInclude("Collect your own evidence with the read-only tools");
    expect(system).toInclude("never use `echo`");
    expect(system).toInclude("If `--scope auto` (the default)");
    expect(system).toInclude("review the working tree when it has staged or unstaged changes");
    expect(system).toInclude(
      "still read untracked files from the working tree because they never appear in the branch diff",
    );
    expect(system).toInclude("<report_contract>");
    expect(system).toInclude(
      "the first line must be exactly `Verdict: approve` or `Verdict: needs-attention`",
    );
    expectDeterministicResolver(system, RESOLVER_REMAINDER_REVIEW);
    expect(system).toInclude("A pull request URL always wins");
    expect(system).toInclude("an all-decimal number is a PR number");
    expect(system).toInclude(
      "A pure-decimal string is never a commit, so `1234567` is PR #1234567",
    );
    expect(system).toInclude("reported plainly as unresolvable and never scope-reviewed");
    expect(system).toInclude("hex matching is case-insensitive (A-F accepted)");
    expect(system).toInclude(
      "a 40-character all-decimal token is read as a commit SHA because the length rule wins over the decimal rule",
    );
    expect(system).toInclude(
      "multiple PR URLs resolve first-URL-wins with the remainder reported, not reviewed",
    );
    expect(system).toInclude("beats `--scope` and `--base`");
    expect(system).toInclude("verify the current repository with `git remote -v`");
    expect(system).toInclude(
      "any `user:token@` credentials in the remote output are redacted before you reason about it",
    );
    expect(system).toInclude(
      "stop and warn explicitly unless the user asked for a cross-repo review",
    );
    expect(system).toInclude("when `gh` fails, report its stderr verbatim");
    expect(system).toInclude("Gate evidence collection on the selected target");
    expect(system).toInclude(
      "Commit target: gather evidence only with `git show <sha>` and `git show <sha>:<file>` for versioned files",
    );
    expect(system).toInclude("Do not read, grep, or glob working-tree copies");
    expect(system).toInclude(
      "if the commit is not available locally, report that plainly instead of guessing",
    );
    expect(system).toInclude("Pull request target: gather `gh` evidence first");
    expect(system).toInclude("verifying it matches the PR head revision");
    expect(system).toInclude("run `git status --short -- <file>` before reading that file");
    expect(system).toInclude("a dirty working-tree copy is not the PR revision");
    expect(system).toInclude("resolve the PR head with `gh pr view <pr-or-url> --json headRefOid`");
    expect(system).toInclude("compare it with `git rev-parse HEAD`");
    expect(system).toInclude(
      "when either value is unavailable, report that plainly and fall back to `gh` evidence",
    );
    expect(system).toInclude(
      "prefer the evidence you collect yourself over the working-tree snapshot blocks",
    );
    expect(system).toInclude("`git merge-base`, `git remote -v`, `git rev-list`");
    expect(system).toInclude(
      "and the read-only `gh pr view` / `gh pr diff` for a pull request target plus the `gh auth status` diagnostic",
    );
    expect(system).not.toInclude(
      "A bare commit SHA (full 40-character or short form) selects that commit",
    );
    expect(system).not.toInclude("A pull request URL or bare PR number selects that pull request");
    expect(system).not.toInclude(
      "A bare all-decimal number is a PR number, a bare hex string of 7 or more characters",
    );
    expect(system).not.toInclude("The target is selected only by a bare commit SHA");
    expect(system).not.toInclude("break confidence");
    expect(system).not.toInclude("Output valid JSON matching this schema");
  });

  test("command pointers paraphrase their prompts and name live prompt anchors", async () => {
    const canonical = await readFile(join(import.meta.dirname, "prompt.ts"), "utf8");
    const cases: Array<{ template: string; prompt: string; anchors: Record<string, string> }> = [
      {
        template: await readFile(COMMAND_ASSET_PATH, "utf8"),
        prompt: await readFile(
          join(import.meta.dirname, "prompts", "adversarial-review.md"),
          "utf8",
        ),
        anchors: {
          "Target selection": "Target selection:",
          "focus weighting": "weight it heavily",
          "evidence rules": "Gate evidence collection on the selected target",
          "output contract": "<structured_output_contract>",
        },
      },
      {
        template: await readFile(CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH, "utf8"),
        prompt: await readFile(
          join(import.meta.dirname, "prompts", "constructive-review.md"),
          "utf8",
        ),
        anchors: {
          "Target selection": "Target selection:",
          "scope flags": "select the review scope with the flags below",
          "no focus text": "focus areas are not supported",
          "evidence rules": "Gate evidence collection on the selected target",
          "output contract": "<report_contract>",
        },
      },
    ];

    for (const { template, prompt, anchors } of cases) {
      for (const [namedArea, anchor] of Object.entries(anchors)) {
        expect(template).toInclude(namedArea);
        expect(prompt).toInclude(anchor);
        expect(canonical).toInclude(anchor);
      }
    }
  });

  test("reviewer agents use a hex color instead of a theme name", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect(context.agents.get(REVIEWER_AGENT_ID)?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(context.agents.get(CONSTRUCTIVE_REVIEW_AGENT_ID)?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test("setup leaves every other agent's permissions untouched", async () => {
    const context = createTestContext({
      agents: [
        { id: "build", mode: "primary" },
        {
          id: "orchestrator",
          mode: "subagent",
          permissions: [
            { action: "subagent", resource: REVIEWER_AGENT_ID, effect: "deny" },
            { action: "skill", resource: "*", effect: "ask" },
          ],
        },
      ],
    });
    const buildBefore = structuredClone(context.agents.get("build")?.permissions);
    const orchestratorBefore = structuredClone(context.agents.get("orchestrator")?.permissions);

    await setupPlugin(context);

    expect(context.agents.get("build")?.permissions).toEqual(buildBefore);
    expect(context.agents.get("orchestrator")?.permissions).toEqual(orchestratorBefore);
    const reviewerDenies = context.agents
      .get("orchestrator")
      ?.permissions.filter(
        (rule) => rule.action === "subagent" && rule.resource === REVIEWER_AGENT_ID,
      );
    expect(reviewerDenies).toHaveLength(1);
  });

  test("a pre-existing host deny outranks the plugin allow for the same resource", async () => {
    const context = createTestContext({
      agents: [
        {
          id: REVIEWER_AGENT_ID,
          permissions: [
            { action: "shell", resource: "git diff*", effect: "deny" },
            { action: "read", resource: "secrets/**", effect: "deny" },
            { action: "read", resource: "docs/**", effect: "allow" },
          ],
        },
      ],
    });
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(effectiveEffect(permissions, "shell", "git diff HEAD")).toBe("deny");
    expect(effectiveEffect(permissions, "read", "secrets/token")).toBe("deny");
    expect(effectiveEffect(permissions, "shell", "git status --short")).toBe("allow");
    expect(effectiveEffect(permissions, "read", "docs/guide.md")).toBe("allow");
    expect(effectiveEffect(permissions, "read", "src/index.ts")).toBe("allow");
  });

  test("reviewer permissions store no asks and evaluate to explicit allow or deny", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions.some((rule) => rule.effect === "ask")).toBe(false);

    const allowed: Array<[string, string]> = [
      ["read", "src/index.ts"],
      ["read", ".env.example"],
      ["glob", "**/*.ts"],
      ["glob", ".env.example"],
      ["grep", "src"],
      ["grep", ".env.example"],
      ["shell", "git blame src/index.ts"],
      ["shell", "git branch --show-current"],
      ["shell", "git diff HEAD"],
      ["shell", "git log -3"],
      ["shell", "git ls-files"],
      ["shell", "git merge-base HEAD main"],
      ["shell", "git rev-list HEAD"],
      ["shell", "git rev-parse HEAD"],
      ["shell", "git show HEAD"],
      ["shell", "git stash list"],
      ["shell", "git stash show"],
      ["shell", "git status --short"],
      ["shell", "gh pr view 123"],
      ["shell", "gh pr view https://github.com/capyBearista/opencode-plugins/pull/7"],
      ["shell", "gh pr diff 123"],
      ["shell", "gh pr diff https://github.com/capyBearista/opencode-plugins/pull/7"],
      ["shell", "gh auth status"],
      ["shell", "git remote -v"],
    ];
    for (const [action, resource] of allowed) {
      expect(effectiveEffect(permissions, action, resource)).toBe("allow");
    }

    const denied: Array<[string, string]> = [
      ["read", ".env"],
      ["read", "secrets/.env.production"],
      ["grep", "*.env"],
      ["grep", "secrets/.env.production"],
      ["glob", "**/.env"],
      ["glob", "**/.env.production"],
      ["shell", "git branch -D topic"],
      ["shell", "git branch -m renamed"],
      ["shell", "git branch --delete topic"],
      ["shell", "git branch --move old new"],
      ["shell", "rm -rf /"],
      ["shell", "git push origin main"],
      ["shell", "git remote add origin https://example.com/repo.git"],
      ["shell", "git remote remove origin"],
      ["shell", "gh"],
      ["shell", "gh issue list"],
      ["shell", "gh auth login"],
      ["shell", "gh auth logout"],
      ["shell", "gh auth status --show-token"],
      ["shell", "gh auth status -t"],
      ["shell", "gh repo view capyBearista/opencode-plugins"],
      ["shell", "gh pr checkout 123"],
      ["shell", "gh pr create --fill"],
      ["shell", "gh pr merge 123"],
      ["shell", "gh api /repos/owner/repo"],
      ["edit", "src/index.ts"],
      ["write", "src/index.ts"],
      ["patch", "src/index.ts"],
      ["webfetch", "https://example.com"],
      ["websearch", "anything"],
      ["subagent", "*"],
      ["question", "*"],
      ["external_directory", "/tmp/elsewhere"],
      ["skill", "*"],
      ["*", "*"],
    ];
    for (const [action, resource] of denied) {
      expect(effectiveEffect(permissions, action, resource)).toBe("deny");
    }
    expect(permissions).toContainEqual({ action: "skill", resource: "*", effect: "deny" });
  });

  test("the review agent reuses the reviewer permission set verbatim", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const adversarial = context.agents.get(REVIEWER_AGENT_ID);
    const review = context.agents.get(CONSTRUCTIVE_REVIEW_AGENT_ID);
    expect(review?.permissions).toEqual(adversarial?.permissions);

    const permissions = review?.permissions ?? [];
    expect(permissions.some((rule) => rule.effect === "ask")).toBe(false);
    expect(effectiveEffect(permissions, "read", "src/index.ts")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "git diff HEAD")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "git branch --show-current")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "git branch -D topic")).toBe("deny");
    expect(effectiveEffect(permissions, "shell", "git diff HEAD --output=/tmp/out.diff")).toBe(
      "deny",
    );
    expect(effectiveEffect(permissions, "edit", "src/index.ts")).toBe("deny");
    expect(effectiveEffect(permissions, "skill", "*")).toBe("deny");
    expect(effectiveEffect(permissions, "read", ".env")).toBe("deny");
    expect(effectiveEffect(permissions, "read", ".env.example")).toBe("allow");
    expect(effectiveEffect(permissions, "*", "*")).toBe("deny");
  });

  // Local approximation of host enforcement: wildcard patterns mirror the
  // host's `Wildcard.match` (opaque string resource, backslash normalization),
  // so a quoted flag such as `--ext"-"diff` can still evade a pattern match.
  // The host shell parser splits compound commands before matching, but this
  // matcher treats the resource as one string. Safe template invocations must
  // allow; branch mutations and diff-engine flags must deny.
  test("the reviewer may run every shell block in the installed command template verbatim", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    const templateCommands = [
      "git branch --show-current",
      "git status --short --untracked-files=all",
      "git log --oneline -3",
      "git diff HEAD",
      "git ls-files --others --exclude-standard",
    ];
    expect(templateCommands).toHaveLength(5);
    for (const command of templateCommands) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const branchMutations = [
      "git branch -D topic",
      "git branch -m renamed",
      "git branch --delete topic",
      "git branch --move old new",
    ];
    for (const command of branchMutations) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  test("dangerous git diff-engine flags are denied after the git allows", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    const safe = [
      "git diff HEAD",
      "git diff --stat",
      "git show HEAD",
      "git log --oneline -3",
      "git stash show",
    ];
    for (const command of safe) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const dangerous = [
      "git diff --ext-diff",
      "git diff HEAD --textconv",
      "git diff HEAD --output=/tmp/out.diff",
      "git show HEAD --ext-diff",
      "git show --textconv HEAD",
      "git show HEAD --output /tmp/out.diff",
      "git log -p --ext-diff -1",
      "git log --textconv -1",
      "git log -1 --output=/tmp/out.log",
      "git stash show -p --ext-diff",
      "git stash show --textconv",
      "git stash show --output=/tmp/stash.diff",
    ];
    for (const command of dangerous) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  // `git diff --no-index` reads arbitrary paths and `git show <rev>:<path>`
  // prints a blob directly, bypassing the read/glob/grep `.env` denies; both
  // denies must stay after the `git diff*` / `git show*` allows. Only the
  // colon-path `.env` / `.env.*` leaf forms are covered; other secret files
  // such as `*.pem` remain readable and are a known limitation.
  test("git secret-path exfiltration is denied after the read-only allows", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "git diff*--no-index*",
      effect: "deny",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "git show*:*.env",
      effect: "deny",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "git show*:*.env.*",
      effect: "deny",
    });

    const allowed = [
      "git diff HEAD",
      "git show HEAD",
      "git show 0123456789abcdef0123456789abcdef01234567",
      "git show HEAD:src/foo.ts",
      "git show HEAD:./src/foo.ts",
      "git show HEAD:src/environment.ts",
      "git show HEAD:src/env.ts",
    ];
    for (const command of allowed) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const denied = [
      "git diff --no-index /dev/null .env",
      "git diff --no-index .env /dev/null",
      "git diff HEAD --no-index .env /dev/null",
      "git show HEAD:.env",
      "git show HEAD:./.env",
      "git show HEAD:config/.env",
      "git show HEAD:config/./.env",
      "git show HEAD:.env.production",
      "git show HEAD:config/.env.production",
    ];
    for (const command of denied) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  // `git show <rev>:<path>` only prints a blob, so `.env.example` stays
  // readable at a revision like it does through read/glob/grep. The allow must
  // come after the `.env` / `.env.*` denies because the host evaluates rules
  // last-match-wins. Its `*` wildcards are unanchored, exactly like the
  // pre-existing read/glob/grep allows: `*.env.example` also matches
  // `foo.env.example`, and the host matcher has no anchor syntax to tighten
  // that, so the rule set keeps the same convention.
  test("git show of a .env.example blob is allowed after the secret-path denies", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "git show*:*.env.example",
      effect: "allow",
    });

    const envDenyIndex = permissions.findIndex(
      (rule) =>
        rule.action === "shell" && rule.resource === "git show*:*.env.*" && rule.effect === "deny",
    );
    const envExampleAllowIndex = permissions.findIndex(
      (rule) =>
        rule.action === "shell" &&
        rule.resource === "git show*:*.env.example" &&
        rule.effect === "allow",
    );
    expect(envDenyIndex).toBeGreaterThanOrEqual(0);
    expect(envExampleAllowIndex).toBeGreaterThan(envDenyIndex);

    const allowed = ["git show HEAD:.env.example", "git show HEAD:config/.env.example"];
    for (const command of allowed) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const denied = [
      "git show HEAD:.env",
      "git show HEAD:./.env",
      "git show HEAD:config/.env",
      "git show HEAD:.env.production",
      "git show HEAD:config/.env.production",
      "git show HEAD:.env.example.production",
    ];
    for (const command of denied) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  test("gh is allowlisted to the read-only PR surface only", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh pr view*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh pr diff*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*--show-token*",
      effect: "deny",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*-t*",
      effect: "deny",
    });
    expect(permissions).toContainEqual({ action: "shell", resource: "gh *", effect: "deny" });

    const allowed = [
      "gh pr view 123",
      "gh pr view https://github.com/capyBearista/opencode-plugins/pull/7",
      "gh pr diff 123",
      "gh pr diff https://github.com/capyBearista/opencode-plugins/pull/7",
      "gh auth status",
    ];
    for (const command of allowed) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const denied = [
      "gh",
      "gh issue list",
      "gh auth login",
      "gh auth logout",
      "gh auth token",
      "gh auth status --show-token",
      "gh auth status -t",
      "gh repo view capyBearista/opencode-plugins",
      "gh pr checkout 123",
      "gh pr create --fill",
      "gh pr merge 123",
      "gh api /repos/owner/repo",
      "gh repo clone owner/repo",
    ];
    for (const command of denied) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  // The host evaluates permissions with a last-match-wins scan, so rule order
  // is load-bearing: the `gh *` catch-all must precede the specific allows, and
  // the specific allows must be ordered most-specific-last.
  test("gh deny and allow rules are ordered most-specific-last", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    const indexOf = (effect: string, resource: string) =>
      permissions.findIndex(
        (rule) => rule.action === "shell" && rule.resource === resource && rule.effect === effect,
      );
    const catchAllIndex = indexOf("deny", "gh *");
    const prViewIndex = indexOf("allow", "gh pr view*");
    const prDiffIndex = indexOf("allow", "gh pr diff*");
    const authStatusIndex = indexOf("allow", "gh auth status*");
    const showTokenIndex = indexOf("deny", "gh auth status*--show-token*");
    const shortTokenIndex = indexOf("deny", "gh auth status*-t*");

    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(prViewIndex).toBeGreaterThan(catchAllIndex);
    expect(prDiffIndex).toBeGreaterThan(prViewIndex);
    expect(authStatusIndex).toBeGreaterThan(prDiffIndex);
    expect(showTokenIndex).toBeGreaterThan(authStatusIndex);
    expect(shortTokenIndex).toBeGreaterThan(authStatusIndex);
  });

  test("git remote and gh auth diagnostics are allowlisted only in their read-only forms", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "git remote -v*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*",
      effect: "allow",
    });
    expect(permissions).not.toContainEqual({
      action: "shell",
      resource: "git remote *",
      effect: "allow",
    });
    expect(permissions).not.toContainEqual({
      action: "shell",
      resource: "gh repo view*",
      effect: "allow",
    });

    expect(effectiveEffect(permissions, "shell", "git remote -v")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "gh auth status")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "gh auth status --hostname github.com")).toBe(
      "allow",
    );

    const denied = [
      "git remote add origin https://example.com/repo.git",
      "git remote remove origin",
      "git remote set-url origin https://example.com/other.git",
      "git remote prune origin",
      "git remote show origin",
      "git remote --verbose",
      "gh repo view capyBearista/opencode-plugins",
      "gh auth login",
      "gh auth logout",
      "gh auth token",
      "gh auth status --show-token",
      "gh auth status -t",
      "gh auth status --show-token --hostname github.com",
    ];
    for (const command of denied) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  test("setup treats a missing permissions array as empty when configuring the reviewer", async () => {
    const context = createTestContext({
      agents: [
        {
          id: REVIEWER_AGENT_ID,
          permissions: undefined as unknown as TestPermission[],
        },
      ],
    });
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(Array.isArray(permissions)).toBe(true);
    expect(permissions.some((rule) => rule.effect === "ask")).toBe(false);
    expect(effectiveEffect(permissions, "read", "src/index.ts")).toBe("allow");
    expect(effectiveEffect(permissions, "edit", "src/index.ts")).toBe("deny");
    expect(effectiveEffect(permissions, "question", "*")).toBe("deny");
  });

  test("missing agent.transform aborts setup before the command file is written", async () => {
    const context = createTestContext();
    (context.ctx.agent as { transform?: unknown }).transform = undefined;

    await expect(setupPlugin(context)).rejects.toThrow(/agent\.transform is unavailable/);
    await expect(stat(join(context.configDir, "commands", COMMAND_FILE_NAME))).rejects.toThrow();
    await expect(
      stat(join(context.configDir, "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME)),
    ).rejects.toThrow();
  });

  test("setup registers no session hooks so reviewers inherit the parent temperature", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    expect(context.hooks.size).toBe(0);
    expect(context.logs).toHaveLength(0);
    await cleanup?.();
  });

  test("registered reviewer configs pin neither a model nor a temperature", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    for (const agentId of [REVIEWER_AGENT_ID, CONSTRUCTIVE_REVIEW_AGENT_ID]) {
      const agent = context.agents.get(agentId);
      expect(agent).toBeDefined();
      expect(Object.hasOwn(agent ?? {}, "model")).toBe(false);
      expect(Object.hasOwn(agent ?? {}, "temperature")).toBe(false);
    }
  });

  test("setup succeeds without a session domain", async () => {
    const context = createTestContext();
    (context.ctx as { session?: unknown }).session = undefined;

    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.agents.has(CONSTRUCTIVE_REVIEW_AGENT_ID)).toBe(true);
    expect(context.hooks.size).toBe(0);
    await cleanup?.();
  });

  test("setup diagnostics prefer a host structured log sink", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const context = createTestContext({
      hostLog: (input) => {
        entries.push(input);
      },
    });
    const configDir = await isolatedConfigDirectory();
    await writeFile(join(configDir, "commands", COMMAND_FILE_NAME), "existing\n");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin(context, configDir);

    expect(entries).toContainEqual({
      service: PLUGIN_ID,
      level: "warn",
      message: `[${PLUGIN_ID}] ${join(configDir, "commands", COMMAND_FILE_NAME)} already exists; leaving it untouched. It may be stale or customized: edit it in place, delete it to reinstall the bundled template, or delete it after removing the plugin to uninstall.`,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    await cleanup?.();
  });

  test("a failing host structured log sink falls back to console.warn", async () => {
    const context = createTestContext({
      hostLog: () => {
        throw new Error("sink unavailable");
      },
    });
    const configDir = await isolatedConfigDirectory();
    await writeFile(join(configDir, "commands", COMMAND_FILE_NAME), "existing\n");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin(context, configDir);

    expect(warnSpy).toHaveBeenCalledWith(
      `[${PLUGIN_ID}] ${join(configDir, "commands", COMMAND_FILE_NAME)} already exists; leaving it untouched. It may be stale or customized: edit it in place, delete it to reinstall the bundled template, or delete it after removing the plugin to uninstall.`,
    );
    warnSpy.mockRestore();
    await cleanup?.();
  });

  test("cleanup disposes both agent registrations and registers no hooks", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    await cleanup?.();

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.agents.has(CONSTRUCTIVE_REVIEW_AGENT_ID)).toBe(true);
    expect(context.hooks.size).toBe(0);
    expect(context.disposers.sort()).toEqual(["agent", "agent"]);
  });

  test("cleanup disposes the second registration when the first dispose throws", async () => {
    const context = createTestContext({ failFirstAgentDispose: true });
    const cleanup = await setupPlugin(context);

    await cleanup?.();

    expect(context.disposers).toEqual(["agent"]);
    expect(context.logs).toContainEqual({
      service: PLUGIN_ID,
      level: "warn",
      message: expect.stringContaining("first agent dispose failed"),
    });
  });

  test("a failing second agent transform disposes the first registration and aborts setup", async () => {
    const context = createTestContext({ failSecondAgentTransform: true });

    await expect(setupPlugin(context)).rejects.toThrow("second agent transform failed");

    expect(context.disposers).toEqual(["agent"]);
    expect(context.agents.has(CONSTRUCTIVE_REVIEW_AGENT_ID)).toBe(false);
  });

  test("setup installs both command files under HOME and writes no agent file", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(
      [REVIEWER_AGENT_ID, CONSTRUCTIVE_REVIEW_AGENT_ID].sort(),
    );
    expect(result.hooks).toEqual([]);
    expect(result.commandTransforms).toBe(0);

    const adversarialAsset = await readFile(COMMAND_ASSET_PATH, "utf8");
    expect(
      await readFile(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME), "utf8"),
    ).toBe(adversarialAsset);
    const adversarialFrontmatter = frontmatterOf(adversarialAsset);
    expect(adversarialFrontmatter.description).toBeString();
    expect(adversarialFrontmatter.description).toInclude("Adversarial");
    expect(adversarialFrontmatter.description).toInclude(
      "Args: [<sha|pr-url|pr-number>] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]",
    );
    expect(adversarialFrontmatter.agent).toBe(REVIEWER_AGENT_ID);
    expect(adversarialFrontmatter.subagent).toBe("true");
    expect(adversarialFrontmatter[MANAGED_VERSION_FIELD]).toBe(CURRENT_MANAGED_VERSION);
    expect(adversarialFrontmatter.metadata).toInclude(MANAGED_VERSION_FIELD);
    expect("model" in adversarialFrontmatter).toBe(false);

    const reviewAsset = await readFile(CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH, "utf8");
    expect(
      await readFile(
        join(home, ".config", "opencode", "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME),
        "utf8",
      ),
    ).toBe(reviewAsset);
    const reviewFrontmatter = frontmatterOf(reviewAsset);
    expect(reviewFrontmatter.description).toBeString();
    expect(reviewFrontmatter.description).toInclude("code review");
    expect(reviewFrontmatter.description).toInclude(
      "Args: [<sha|pr-url|pr-number>] [--base <ref>] [--scope auto|working-tree|branch]",
    );
    expect(reviewFrontmatter.agent).toBe(CONSTRUCTIVE_REVIEW_AGENT_ID);
    expect(reviewFrontmatter.subagent).toBe("true");
    expect(reviewFrontmatter[MANAGED_VERSION_FIELD]).toBe(CURRENT_MANAGED_VERSION);
    expect(reviewFrontmatter.metadata).toInclude(MANAGED_VERSION_FIELD);
    expect("model" in reviewFrontmatter).toBe(false);
    expect(reviewAsset).not.toInclude("acknowledged");

    for (const [fileName, asset, pointerMarker] of [
      [COMMAND_FILE_NAME, adversarialAsset, "focus weighting"],
      [CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME, reviewAsset, "scope flags"],
    ] as const) {
      expect(asset).toInclude("$ARGUMENTS");
      expect(asset.match(/!`[^`]+`/g) ?? []).toHaveLength(5);
      expect(asset.match(/!`[^`]*2>&1 \|\| true`/g) ?? []).toHaveLength(5);
      for (const label of [
        "- Branch:",
        "- Status:",
        "- Recent commits:",
        "- Working-tree diff against HEAD:",
        "- Untracked files (paths only; read their contents with your tools):",
      ]) {
        expect(asset).toInclude(label);
      }
      for (const command of [
        "git branch --show-current",
        "git status --short",
        "git log --oneline -3",
        "git diff HEAD",
        "git ls-files --others",
      ]) {
        expect(asset).toInclude(command);
      }
      expect(asset).toInclude(pointerMarker);
      expect(asset).toInclude(
        "The blocks below are a point-in-time snapshot rendered by this template.",
      );
      expect(asset).not.toInclude("GNU/Linux");
      expect(asset).not.toInclude("Bash");
      const allowlisted = DOCTRINE_TRIPWIRE_ALLOWLIST[fileName] ?? [];
      for (const phrase of TEMPLATE_TRIPWIRE_PHRASES) {
        if (allowlisted.some((guardrail) => guardrail.includes(phrase))) continue;
        expect(asset).not.toInclude(phrase);
      }
    }
    expect(reviewAsset).toInclude(REVIEW_ONLY_GUARDRAIL);

    const bunCachePrefix = join(".bun", "");
    expect((await walkFiles(home)).filter((file) => !file.startsWith(bunCachePrefix))).toEqual([
      join(".config", "opencode", "commands", COMMAND_FILE_NAME),
      join(".config", "opencode", "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME),
    ]);
  });

  test("both installed command files persist on disk after dispose", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    await cleanup?.();

    expect(await readFile(join(context.configDir, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    expect(
      await readFile(
        join(context.configDir, "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME),
        "utf8",
      ),
    ).toBe(await readFile(CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH, "utf8"));
  });

  test("packaged command templates carry the managed_version stamp and ownership metadata", async () => {
    for (const assetPath of [COMMAND_ASSET_PATH, CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH]) {
      const asset = await readFile(assetPath, "utf8");
      const frontmatter = frontmatterOf(asset);
      expect(frontmatter[MANAGED_VERSION_FIELD]).toBe(CURRENT_MANAGED_VERSION);
      expect(frontmatter.metadata).toInclude(PACKAGE_NAME);
      expect(frontmatter.metadata).toInclude(MANAGED_VERSION_FIELD);
      expect(frontmatter.metadata).toInclude("take ownership");
      expect(frontmatter.metadata).toInclude("preserved");
      expect(frontmatter.metadata).toInclude("newer than the shipped template");
      expect(frontmatter.metadata).not.toInclude("overridden");
      for (const key of Object.keys(frontmatter)) {
        expect(COMMAND_FRONTMATTER_KEYS).toContain(
          key as (typeof COMMAND_FRONTMATTER_KEYS)[number],
        );
      }
    }
  });

  describe("managed version handling", () => {
    test("parses only canonical positive decimal integer stamps", () => {
      const stamped = (value: string) =>
        `---\ndescription: x\n${MANAGED_VERSION_FIELD}: ${value}\n---\nbody\n`;

      expect(managedVersionOf(stamped("1"))).toBe(1);
      expect(managedVersionOf(stamped("42"))).toBe(42);
      expect(managedVersionOf("body only\n")).toBeUndefined();
      expect(managedVersionOf("---\ndescription: x\n---\nbody\n")).toBeUndefined();
      for (const value of ["1.0", "+1", "0x1", "1e2", "", "0", "-1"]) {
        expect(managedVersionOf(stamped(value))).toBeUndefined();
      }
    });

    test("refreshes known stamps no newer than the shipped template", () => {
      expect(isManagedUpgrade(1, [1, 2], 2)).toBe(true);
      expect(isManagedUpgrade(2, [1, 2], 2)).toBe(true);
      expect(isManagedUpgrade(1, [1], 1)).toBe(true);
      expect(isManagedUpgrade(3, [1, 2], 2)).toBe(false);
      expect(isManagedUpgrade(4, [1, 2], 2)).toBe(false);
      expect(isManagedUpgrade(0, [1, 2], 2)).toBe(false);
    });

    test("lists every version from 1 up to the shipped template version as refreshable", () => {
      for (let version = 1; version < CURRENT_TEMPLATE_VERSION; version += 1) {
        expect(KNOWN_TEMPLATE_VERSIONS).toContain(version);
      }
      expect(KNOWN_TEMPLATE_VERSIONS).toContain(CURRENT_TEMPLATE_VERSION);
      expect(KNOWN_TEMPLATE_VERSIONS).not.toContain(CURRENT_TEMPLATE_VERSION + 1);
    });
  });

  test("a stamped managed command file is refreshed in place with an info log", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const stale = `---\ndescription: stale managed copy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\nstale body\n`;
    await writeFile(installed, stale);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(
      [REVIEWER_AGENT_ID, CONSTRUCTIVE_REVIEW_AGENT_ID].sort(),
    );
    expect(await readFile(installed, "utf8")).toBe(await readFile(COMMAND_ASSET_PATH, "utf8"));
    const updates = result.logs.filter(
      (entry) => entry.level === "info" && entry.message.includes(installed),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.message).toInclude(`${MANAGED_VERSION_FIELD} 1`);
    expect(result.logs.some((entry) => entry.level === "warn")).toBe(false);
    expect(await readFile(join(commands, CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH, "utf8"),
    );
  });

  // The refresh write uses O_TRUNC, so a mid-write failure can strand a
  // truncated or stamp-less partial file that later setups would preserve
  // forever. Setup unlinks that path on failure so the next run takes the
  // fresh `wx` path; unlink on a symlink leaf removes only the link.
  test("a failed refresh overwrite unlinks the partial file and registers neither agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const stale = `---\ndescription: stale managed copy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\nstale body\n`;
    await writeFile(installed, stale);

    const result = await runSetupInSubprocess({
      home,
      refreshWriteError: {
        code: "EACCES",
        message: `EACCES: permission denied, open '${installed}'`,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude("Unable to install the /adversarial-review command");
    expect(result.error).toInclude(installed);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(installed)).rejects.toThrow();
    await expect(stat(join(commands, CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME))).rejects.toThrow();

    const recovery = await runSetupInSubprocess({ home });
    expect(recovery.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(await readFile(COMMAND_ASSET_PATH, "utf8"));
  });

  // Regression: the refresh used to unlink unconditionally when its write
  // failed, deleting a readable-but-unwritable managed file even though the
  // O_TRUNC open never ran and no byte was lost. Only a handle write after a
  // successful O_TRUNC open can strand a partial file; a failed open must
  // preserve the intact file and still fail setup loudly.
  test("a failed refresh open preserves a read-only managed file and fails setup", async () => {
    // A root-run test cannot produce EACCES from file mode bits; the mock-based
    // partial-write coverage still exercises the unlink path in that case.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const stale = `---\ndescription: stale managed copy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\nstale body\n`;
    await writeFile(installed, stale);
    await chmod(installed, 0o444);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude("Unable to install the /adversarial-review command");
    expect(result.error).toInclude(installed);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    expect(await readFile(installed, "utf8")).toBe(stale);
    await expect(stat(join(commands, CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME))).rejects.toThrow();
  });

  test("a stamped pre-rename review command is removed with an info log", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const stale = join(commands, STALE_REVIEW_COMMAND_FILE_NAME);
    const staleContents = `---\ndescription: stale pre-rename review\nagent: ${PRE_RENAME_REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\nstale body\n`;
    await writeFile(stale, staleContents);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(
      [REVIEWER_AGENT_ID, CONSTRUCTIVE_REVIEW_AGENT_ID].sort(),
    );
    await expect(stat(stale)).rejects.toThrow();
    const removals = result.logs.filter(
      (entry) => entry.level === "info" && entry.message.includes(stale),
    );
    expect(removals).toHaveLength(1);
    expect(removals[0]?.message).toInclude("Removed");
    expect(result.logs.some((entry) => entry.level === "warn")).toBe(false);
    expect(await readFile(join(commands, COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    expect(await readFile(join(commands, CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH, "utf8"),
    );
  });

  test("an unstamped or unknown-stamped pre-rename review command is preserved with a warning", async () => {
    const variants = [
      `---\ndescription: old unstamped review\nagent: ${PRE_RENAME_REVIEWER_AGENT_ID}\nsubagent: true\n---\n\nold body\n`,
      `---\ndescription: newer pre-rename review\nagent: ${PRE_RENAME_REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 99\n---\n\nnewer body\n`,
    ];

    for (const staleContents of variants) {
      const home = await temporaryDirectory("adversarial-review-home-");
      const commands = join(home, ".config", "opencode", "commands");
      await mkdir(commands, { recursive: true });
      const stale = join(commands, STALE_REVIEW_COMMAND_FILE_NAME);
      await writeFile(stale, staleContents);

      const result = await runSetupInSubprocess({ home });

      expect(result.ok).toBe(true);
      expect(await readFile(stale, "utf8")).toBe(staleContents);
      const warnings = result.logs.filter(
        (entry) => entry.level === "warn" && entry.message.includes(stale),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toInclude("broken");
      expect(warnings[0]?.message).toInclude("delete that file manually");
      expect(result.logs.some((entry) => entry.level === "info")).toBe(false);
      expect(await readFile(join(commands, COMMAND_FILE_NAME), "utf8")).toBe(
        await readFile(COMMAND_ASSET_PATH, "utf8"),
      );
    }
  }, 30_000);

  test("an unrelated user review command is preserved silently", async () => {
    const variants = [
      `---\ndescription: user command\nagent: my-own-reviewer\n---\n\nuser body\n`,
      `# user notes\n\nnot a command\n`,
    ];

    for (const contents of variants) {
      const home = await temporaryDirectory("adversarial-review-home-");
      const commands = join(home, ".config", "opencode", "commands");
      await mkdir(commands, { recursive: true });
      const userFile = join(commands, STALE_REVIEW_COMMAND_FILE_NAME);
      await writeFile(userFile, contents);

      const result = await runSetupInSubprocess({ home });

      expect(result.ok).toBe(true);
      expect(await readFile(userFile, "utf8")).toBe(contents);
      expect(result.logs).toHaveLength(0);
    }
  }, 30_000);

  test("removing the managed_version stamp takes ownership and preserves the file", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const asset = await readFile(COMMAND_ASSET_PATH, "utf8");
    const owned = asset.replace(`\n${MANAGED_VERSION_FIELD}: ${CURRENT_MANAGED_VERSION}\n`, "\n");
    await writeFile(installed, owned);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(owned);
    const warnings = result.logs.filter(
      (entry) => entry.level === "warn" && entry.message.includes(installed),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toInclude("stale or customized");
    expect(result.logs.some((entry) => entry.level === "info")).toBe(false);
  });

  test("a command file stamped with a newer managed version is preserved with a warning", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const future = `---\ndescription: future managed copy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 99\n---\n\nfuture body\n`;
    await writeFile(installed, future);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(future);
    const warnings = result.logs.filter(
      (entry) => entry.level === "warn" && entry.message.includes(installed),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toInclude("stale or customized");
    expect(result.logs.some((entry) => entry.level === "info")).toBe(false);
  });

  test("non-canonical managed_version stamps are preserved with a warning", async () => {
    for (const stamp of ["1.0", "+1", "0x1", "1e2", "", "0", "-1"]) {
      const home = await temporaryDirectory("adversarial-review-home-");
      const commands = join(home, ".config", "opencode", "commands");
      await mkdir(commands, { recursive: true });
      const installed = join(commands, COMMAND_FILE_NAME);
      const contents = `---\ndescription: malformed stamp\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: ${stamp}\n---\n\nbody\n`;
      await writeFile(installed, contents);

      const result = await runSetupInSubprocess({ home });

      expect(result.ok).toBe(true);
      expect(await readFile(installed, "utf8")).toBe(contents);
      const warnings = result.logs.filter(
        (entry) => entry.level === "warn" && entry.message.includes(installed),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toInclude("stale or customized");
      expect(result.logs.some((entry) => entry.level === "info")).toBe(false);
    }
  }, 30_000);

  test("setup warns once and continues when O_NOFOLLOW is unavailable", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });

    const result = await runSetupInSubprocess({ home, noFollowUnavailable: true });

    expect(result.ok).toBe(true);
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(
      [REVIEWER_AGENT_ID, CONSTRUCTIVE_REVIEW_AGENT_ID].sort(),
    );
    const warnings = result.logs.filter(
      (entry) => entry.level === "warn" && entry.message.includes("O_NOFOLLOW"),
    );
    expect(warnings).toHaveLength(1);
    expect(
      await readFile(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME), "utf8"),
    ).toBe(await readFile(COMMAND_ASSET_PATH, "utf8"));
  });

  test("a symlink swapped in after lstat is caught by the no-follow read", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const missingTarget = join(home, "missing-target.md");
    await symlink(missingTarget, installed);

    // The dangling symlink would turn a following read into ENOENT and abort
    // setup; the O_NOFOLLOW read fails with ELOOP and preserves the path.
    const result = await runSetupInSubprocess({ home, maskLstatFor: COMMAND_FILE_NAME });

    expect(result.ok).toBe(true);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(missingTarget);
    const warnings = result.logs.filter(
      (entry) => entry.level === "warn" && entry.message.includes(installed),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toInclude("leaving it untouched");
  });

  test("a managed file deleted between the check and the refresh is recreated", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const stale = `---\ndescription: stale managed copy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\nstale body\n`;
    await writeFile(installed, stale);

    const result = await runSetupInSubprocess({ home, deleteOnRead: COMMAND_FILE_NAME });

    expect(result.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(await readFile(COMMAND_ASSET_PATH, "utf8"));
    const updates = result.logs.filter(
      (entry) => entry.level === "info" && entry.message.includes(installed),
    );
    expect(updates).toHaveLength(1);
  });

  test("a close failure cannot mask the read error that aborted the install", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const installed = join(commands, COMMAND_FILE_NAME);
    const stale = `---\ndescription: stale managed copy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\nstale body\n`;
    await writeFile(installed, stale);

    const result = await runSetupInSubprocess({ home, failReadAndClose: COMMAND_FILE_NAME });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude("Unable to install the /adversarial-review command");
    expect(result.error).toInclude("EACCES: permission denied, read");
    expect(result.error).not.toInclude("close failed");
    expect(result.agents).toHaveLength(0);
    expect(await readFile(installed, "utf8")).toBe(stale);
  });

  test("a symlinked path to a stamped managed file is never followed or overwritten", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const decoy = join(home, "managed-decoy.md");
    const managed = `---\ndescription: managed decoy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\ndecoy body\n`;
    await writeFile(decoy, managed);
    const installed = join(commands, COMMAND_FILE_NAME);
    await symlink(decoy, installed);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(decoy);
    expect(await readFile(decoy, "utf8")).toBe(managed);
    expect(result.logs.some((entry) => entry.level === "info")).toBe(false);
  });

  test("a managed refresh falls back to console.info when the host sink fails", async () => {
    const context = createTestContext({
      hostLog: () => {
        throw new Error("sink unavailable");
      },
    });
    const configDir = await isolatedConfigDirectory();
    const installed = join(configDir, "commands", COMMAND_FILE_NAME);
    await writeFile(
      installed,
      `---\ndescription: stale managed copy\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n${MANAGED_VERSION_FIELD}: 1\n---\n\nstale body\n`,
    );
    const infoSpy = spyOn(console, "info").mockImplementation(() => {});

    const cleanup = await setupPlugin(context, configDir);

    expect(infoSpy).toHaveBeenCalledWith(
      `[${PLUGIN_ID}] Updating the managed command file at ${installed} from the bundled template (${MANAGED_VERSION_FIELD} 1).`,
    );
    infoSpy.mockRestore();
    await cleanup?.();
  });

  test("a second setup preserves hand-edited bytes and warns about the existing file", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });
    await runSetupInSubprocess({ home });

    const installed = join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME);
    const edited = `---\ndescription: custom review\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n---\n\ncustom body\n`;
    await writeFile(installed, edited);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(edited);
    const diagnostics = result.logs.filter(
      (entry) =>
        entry.message.includes("leaving it untouched") && entry.message.includes(installed),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warn");
    expect(diagnostics[0]?.message).toInclude("stale or customized");
    expect(diagnostics[0]?.message).toInclude("delete it");
    expect(diagnostics[0]?.message).toInclude("uninstall");
  });

  test("a pre-existing review command file keeps its bytes and warns without naming the wrong path", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });
    const installed = join(
      home,
      ".config",
      "opencode",
      "commands",
      CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME,
    );
    const edited = `---\ndescription: custom review\nagent: ${CONSTRUCTIVE_REVIEW_AGENT_ID}\nsubagent: true\n---\n\ncustom body\n`;
    await writeFile(installed, edited);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(edited);
    const diagnostics = result.logs.filter((entry) =>
      entry.message.includes("leaving it untouched"),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warn");
    expect(diagnostics[0]?.message).toInclude(installed);
    expect(diagnostics[0]?.message).toInclude("stale or customized");
    expect(
      await readFile(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME), "utf8"),
    ).toBe(await readFile(COMMAND_ASSET_PATH, "utf8"));
  });

  test("setup does not follow or replace a symlinked command path", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const decoy = join(home, "decoy.md");
    await writeFile(decoy, "decoy bytes\n");
    const installed = join(commands, COMMAND_FILE_NAME);
    await symlink(decoy, installed);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(decoy);
    expect(await readFile(decoy, "utf8")).toBe("decoy bytes\n");
  });

  test("setup does not follow or replace a symlinked review command path", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const decoy = join(home, "review-decoy.md");
    await writeFile(decoy, "decoy bytes\n");
    const installed = join(commands, CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME);
    await symlink(decoy, installed);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(decoy);
    expect(await readFile(decoy, "utf8")).toBe("decoy bytes\n");
    expect(await readFile(join(commands, COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
  });

  test("OPENCODE_CONFIG_DIR targets only the override directory", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const override = await isolatedConfigDirectory();

    const result = await runSetupInSubprocess({ home, opencodeConfigDir: override });

    expect(result.ok).toBe(true);
    expect(await readFile(join(override, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    expect(
      await readFile(join(override, "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME), "utf8"),
    ).toBe(await readFile(CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH, "utf8"));
    await expect(
      stat(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME)),
    ).rejects.toThrow();
    await expect(
      stat(join(home, ".config", "opencode", "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME)),
    ).rejects.toThrow();
  });

  test("an empty or whitespace-only OPENCODE_CONFIG_DIR falls back to the HOME config directory", async () => {
    for (const override of ["", "   "]) {
      const home = await temporaryDirectory("adversarial-review-home-");
      await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });

      const result = await runSetupInSubprocess({ home, opencodeConfigDir: override });

      expect(result.ok).toBe(true);
      expect(
        await readFile(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME), "utf8"),
      ).toBe(await readFile(COMMAND_ASSET_PATH, "utf8"));
      expect(
        await readFile(
          join(home, ".config", "opencode", "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME),
          "utf8",
        ),
      ).toBe(await readFile(CONSTRUCTIVE_REVIEW_COMMAND_ASSET_PATH, "utf8"));
    }
  });

  test("a missing commands parent fails setup with a path-bearing error and no agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const broken = join(home, "missing-config");

    const result = await runSetupInSubprocess({ home, opencodeConfigDir: broken });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(join(broken, "commands", COMMAND_FILE_NAME));
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(broken)).rejects.toThrow();
  });

  test("a writeFile permission failure fails setup loudly without registering an agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const commandPath = join(configDir, "commands", COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      writeFileError: {
        code: "EACCES",
        message: `EACCES: permission denied, open '${commandPath}'`,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(commandPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(commandPath)).rejects.toThrow();
  });

  test("a read-only filesystem review install failure registers neither agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const reviewPath = join(configDir, "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      writeFileError: {
        code: "EROFS",
        message: `EROFS: read-only file system, open '${reviewPath}'`,
        onlyFor: CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(reviewPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(reviewPath)).rejects.toThrow();
    expect(await readFile(join(configDir, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
  });

  test("a missing packaged command template fails setup with a path-bearing error and no agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const assetPath = join(PACKAGE_ROOT, "commands", COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      readFileError: {
        code: "ENOENT",
        message: `ENOENT: no such file or directory, open '${assetPath}'`,
        onlyFor: COMMAND_FILE_NAME,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(assetPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(join(configDir, "commands", COMMAND_FILE_NAME))).rejects.toThrow();
    await expect(
      stat(join(configDir, "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME)),
    ).rejects.toThrow();
  });

  test("an unreadable packaged review template leaves the first command on disk but registers neither agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const assetPath = join(PACKAGE_ROOT, "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      readFileError: {
        code: "EACCES",
        message: `EACCES: permission denied, open '${assetPath}'`,
        onlyFor: CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(assetPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    expect(await readFile(join(configDir, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    await expect(
      stat(join(configDir, "commands", CONSTRUCTIVE_REVIEW_COMMAND_FILE_NAME)),
    ).rejects.toThrow();
  });
});
