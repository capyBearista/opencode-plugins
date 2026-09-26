import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
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
import plugin from "./index.js";

type TestPermission = { action: string; resource: string; effect: string };

type TestAgent = {
  id: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
  system?: string;
  color?: string;
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
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const JSON_VERBATIM_RULE =
  "Return only valid JSON, verbatim. Do not wrap the JSON in markdown fences or add commentary outside the JSON object.";

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
        callback(editor);
        return {
          dispose: async () => {
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

async function runSetupInSubprocess(configuration: {
  home: string;
  opencodeConfigDir?: string;
  writeFileError?: { code: string; message: string };
}): Promise<SubprocessSetup> {
  const pluginURL = pathToFileURL(join(PACKAGE_ROOT, "src", "index.ts")).href;
  const writeFileMock =
    configuration.writeFileError === undefined
      ? ""
      : `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    mock.module("node:fs/promises", () => ({
      ...fs,
      writeFile: async () => {
        const error = new Error(${JSON.stringify(configuration.writeFileError.message)});
        error.code = ${JSON.stringify(configuration.writeFileError.code)};
        throw error;
      },
    }));
  `;
  const script = `
    ${writeFileMock}
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

  test("reviewer description names the installed command template path", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const description = context.agents.get(REVIEWER_AGENT_ID)?.description ?? "";
    expect(description).toInclude("Do not invoke adversarial-reviewer directly");
    expect(description).toInclude("/adversarial-review");
    expect(description).toInclude("only supported path");
    expect(description).toInclude(join(context.configDir, "commands", COMMAND_FILE_NAME));
    expect(description).not.toInclude("collected Git context");
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
    expect(agent?.description).toInclude("/adversarial-review");
    expect(agent?.system).toBe("custom system");
    expect(agent?.color).toBe("#123456");
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
    expect(system).toInclude("Treat that snapshot as a starting point, not as a complete record");
    expect(system).toInclude("<attack_surface>");
    expect(system).toInclude("<finding_bar>");
    expect(system).toInclude("<structured_output_contract>");
    expect(system).toInclude("If `--scope auto` (the default)");
    expect(system).toInclude("review the working tree when it has staged or unstaged changes");
    expect(system).not.toInclude("The inline Git context is primary evidence");
    expect(system).not.toInclude("full text bodies of unignored untracked files");
  });

  test("reviewer agent uses a hex color instead of a theme name", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect(context.agents.get(REVIEWER_AGENT_ID)?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
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
      "git diff HEAD --output=/tmp/review.diff",
      "git show HEAD --ext-diff",
      "git show --textconv HEAD",
      "git show HEAD --output /tmp/review.diff",
      "git log -p --ext-diff -1",
      "git log --textconv -1",
      "git log -1 --output=/tmp/review.log",
      "git stash show -p --ext-diff",
      "git stash show --textconv",
      "git stash show --output=/tmp/stash.diff",
    ];
    for (const command of dangerous) {
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
  });

  test("missing session.hook is handled without throwing", async () => {
    const context = createTestContext();
    (context.ctx.session as { hook?: unknown }).hook = undefined;

    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.logs).toContainEqual({
      service: PLUGIN_ID,
      level: "error",
      message: `[${PLUGIN_ID}] session.hook is unavailable; review temperature was not pinned`,
    });
    await cleanup?.();
  });

  test("setup diagnostics prefer a host structured log sink", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const context = createTestContext({
      hostLog: (input) => {
        entries.push(input);
      },
    });
    (context.ctx.session as { hook?: unknown }).hook = undefined;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await setupPlugin(context);

    expect(entries).toContainEqual({
      service: PLUGIN_ID,
      level: "error",
      message: `[${PLUGIN_ID}] session.hook is unavailable; review temperature was not pinned`,
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    await cleanup?.();
  });

  test("a failing host structured log sink falls back to console.error", async () => {
    const context = createTestContext({
      hostLog: () => {
        throw new Error("sink unavailable");
      },
    });
    (context.ctx.session as { hook?: unknown }).hook = undefined;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await setupPlugin(context);

    expect(errorSpy).toHaveBeenCalledWith(
      `[${PLUGIN_ID}] session.hook is unavailable; review temperature was not pinned`,
    );
    errorSpy.mockRestore();
    await cleanup?.();
  });

  test("review temperature hooks fire for the reviewer agent only", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect([...context.hooks.keys()].sort()).toEqual(["context", "generate"]);

    const reviewer: HookEvent = { sessionID: "ses_review", agent: REVIEWER_AGENT_ID, options: {} };
    const foreign: HookEvent = { sessionID: "ses_build", agent: "build", options: {} };
    const anonymous: HookEvent = { sessionID: "ses_unknown", options: {} };
    for (const name of ["context", "generate"]) {
      const hook = context.hooks.get(name);
      hook?.(reviewer);
      hook?.(foreign);
      hook?.(anonymous);
    }

    expect(reviewer.options.temperature).toBe(0.1);
    expect(foreign.options.temperature).toBeUndefined();
    expect(anonymous.options.temperature).toBeUndefined();
  });

  test("temperature hooks warn once per observed non-reviewer agent", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const reviewer: HookEvent = { sessionID: "ses_review", agent: REVIEWER_AGENT_ID, options: {} };
    const foreign: HookEvent = { sessionID: "ses_build", agent: "build", options: {} };
    const anonymous: HookEvent = { sessionID: "ses_unknown", options: {} };
    for (const name of ["context", "generate"]) {
      const hook = context.hooks.get(name);
      hook?.(reviewer);
      hook?.(foreign);
      hook?.(anonymous);
      hook?.(foreign);
      hook?.(anonymous);
    }

    expect(reviewer.options.temperature).toBe(0.1);
    const warnings = context.logs.filter(
      (entry) => entry.level === "warn" && entry.message.includes("temperature"),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.message).toInclude('agent "build"');
    expect(warnings[0]?.message).toInclude(`"${REVIEWER_AGENT_ID}" only`);
    expect(warnings[1]?.message).toInclude("no agent");
  });

  test("cleanup disposes the agent registration and both temperature hooks", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    await cleanup?.();

    expect(context.disposers.sort()).toEqual(["agent", "hook:context", "hook:generate"]);
  });

  test("setup installs the command file under HOME and writes no agent file", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(result.agents.map((agent) => agent.id)).toEqual([REVIEWER_AGENT_ID]);
    expect(result.hooks).toEqual(["context", "generate"]);
    expect(result.commandTransforms).toBe(0);

    const installed = join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME);
    const asset = await readFile(COMMAND_ASSET_PATH, "utf8");
    expect(await readFile(installed, "utf8")).toBe(asset);

    const frontmatter = frontmatterOf(asset);
    expect(frontmatter.description).toBeString();
    expect(frontmatter.description).toInclude("adversarial");
    expect(frontmatter.agent).toBe(REVIEWER_AGENT_ID);
    expect(frontmatter.subagent).toBe("true");
    expect("model" in frontmatter).toBe(false);

    expect(asset).toInclude("$ARGUMENTS");
    expect(asset.match(/!`[^`]+`/g) ?? []).toHaveLength(5);
    for (const command of [
      "git branch --show-current",
      "git status --short",
      "git log --oneline -3",
      "git diff HEAD",
      "git ls-files --others",
    ]) {
      expect(asset).toInclude(command);
    }
    expect(asset).toInclude("GNU/Linux");

    const bunCachePrefix = join(".bun", "");
    expect((await walkFiles(home)).filter((file) => !file.startsWith(bunCachePrefix))).toEqual([
      join(".config", "opencode", "commands", COMMAND_FILE_NAME),
    ]);
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
    const diagnostics = result.logs.filter((entry) =>
      entry.message.includes("leaving it untouched"),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warn");
    expect(diagnostics[0]?.message).toInclude(installed);
    expect(diagnostics[0]?.message).toInclude("stale or customized");
    expect(diagnostics[0]?.message).toInclude("delete it");
    expect(diagnostics[0]?.message).toInclude("uninstall");
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

  test("OPENCODE_CONFIG_DIR targets only the override directory", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const override = await isolatedConfigDirectory();

    const result = await runSetupInSubprocess({ home, opencodeConfigDir: override });

    expect(result.ok).toBe(true);
    expect(await readFile(join(override, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    await expect(
      stat(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME)),
    ).rejects.toThrow();
  });

  test("a missing commands parent fails setup with a path-bearing error and no agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const broken = join(home, "missing-config");

    const result = await runSetupInSubprocess({ home, opencodeConfigDir: broken });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(join(broken, "commands", COMMAND_FILE_NAME));
    expect(result.error).toInclude("was not registered");
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
    expect(result.error).toInclude("was not registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(commandPath)).rejects.toThrow();
  });
});
