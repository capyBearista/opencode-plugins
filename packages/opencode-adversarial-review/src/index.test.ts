import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectGitContext } from "./git-context.js";
import plugin from "./index.js";

type TestPermission = { action: string; resource: string; effect: string };

type TestAgent = {
  id: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
  system?: string;
  color?: string;
  permissions: TestPermission[];
};

type TestModel = { providerID: string; id: string; variant?: string };

type TestInvocation = {
  sessionID: string;
  prompt: {
    text: string;
    files?: Array<{ uri: string }>;
    agents?: Array<{ name: string }>;
    skills?: Array<{ id: string }>;
  };
  delivery: "steer" | "queue";
};

type TestCommand = {
  name: string;
  description?: string;
  execute: (invocation: TestInvocation) => Promise<void>;
};

type HookEvent = { sessionID: string; options: Record<string, unknown> };

type TestAssistantMessage = {
  content: Array<Record<string, unknown>>;
  error?: Record<string, unknown>;
};

type TestContextOptions = {
  options?: Record<string, unknown>;
  directory?: string;
  projectDirectory?: string;
  agents?: TestAgent[];
  callerModel?: TestModel | null;
  sessionGetError?: Error;
  assistantText?: string;
  assistantContent?: Array<Record<string, unknown>>;
  assistantMessages?: TestAssistantMessage[];
  createError?: Error;
  promptError?: Error;
  waitError?: Error;
  contextError?: Error;
  syntheticError?: Error;
  hostLog?: (input: Record<string, unknown>) => unknown;
};

const REVIEWER_AGENT_ID = "adversarial-reviewer";
const COMMAND_NAME = "adversarial-review";
const CALLER_MODEL: TestModel = { providerID: "caller-provider", id: "caller-model" };
const VALID_REVIEW_JSON = '{"verdict":"approve","summary":"safe","findings":[],"next_steps":[]}';
const REVIEW_FAILURE_PREFIX = "Adversarial review failed";

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

function createTestContext(input: TestContextOptions = {}) {
  const agents = new Map<string, TestAgent>(
    (input.agents ?? []).map((agent) => [
      agent.id,
      { permissions: [{ action: "*", resource: "*", effect: "allow" }], ...agent },
    ]),
  );
  const commands: TestCommand[] = [];
  const hooks = new Map<string, (event: HookEvent) => void>();
  const hookEvents: Array<{ name: string; event: HookEvent }> = [];
  const disposers: string[] = [];
  const created: Array<Record<string, unknown> & { id: string }> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const synthetics: Array<Record<string, unknown>> = [];
  const waits: string[] = [];
  const sessionGets: string[] = [];

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

  const assistantMessages: TestAssistantMessage[] =
    input.assistantMessages !== undefined
      ? input.assistantMessages
      : input.assistantContent !== undefined
        ? [{ content: input.assistantContent }]
        : input.assistantText === undefined
          ? []
          : [{ content: [{ type: "text", text: input.assistantText }] }];

  const ctx = {
    options: input.options ?? {},
    app: {
      name: "opencode",
      version: "test",
      channel: "test",
      ...(input.hostLog === undefined ? {} : { log: input.hostLog }),
    },
    location: {
      directory: input.directory ?? process.cwd(),
      project: { directory: input.projectDirectory ?? input.directory ?? process.cwd() },
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
    command: {
      transform: async (callback: (value: { add: (command: TestCommand) => void }) => void) => {
        callback({ add: (command) => commands.push(command) });
        return {
          dispose: async () => {
            disposers.push("command");
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
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionGets.push(sessionID);
        if (input.sessionGetError) throw input.sessionGetError;
        return {
          id: sessionID,
          model: input.callerModel === undefined ? CALLER_MODEL : (input.callerModel ?? undefined),
        };
      },
      create: async (value: Record<string, unknown>) => {
        if (input.createError) throw input.createError;
        const session = { id: `ses_review_${created.length + 1}`, ...value };
        created.push(session);
        return session;
      },
      prompt: async (value: Record<string, unknown>) => {
        if (input.promptError) throw input.promptError;
        prompts.push(value);
        return {};
      },
      wait: async (value: { sessionID: string }) => {
        if (input.waitError) throw input.waitError;
        waits.push(value.sessionID);
        for (const [name, hook] of hooks) {
          const event: HookEvent = { sessionID: value.sessionID, options: {} };
          hook(event);
          hookEvents.push({ name, event });
        }
      },
      context: async () => {
        if (input.contextError) throw input.contextError;
        return assistantMessages.map((message) => ({ type: "assistant", ...message }));
      },
      synthetic: async (value: Record<string, unknown>) => {
        if (input.syntheticError) throw input.syntheticError;
        synthetics.push(value);
        return {};
      },
    },
  };

  return {
    ctx,
    agents,
    commands,
    hooks,
    hookEvents,
    disposers,
    created,
    prompts,
    synthetics,
    waits,
    sessionGets,
  };
}

type TestContext = ReturnType<typeof createTestContext>;

async function setupPlugin(context: TestContext) {
  return plugin.setup(context.ctx as never);
}

async function runReview(
  context: TestContext,
  text: string,
  delivery: "steer" | "queue" = "steer",
) {
  const command = context.commands.find((candidate) => candidate.name === COMMAND_NAME);
  if (!command) throw new Error("adversarial-review command was not registered");
  await command.execute({
    sessionID: "ses_caller",
    prompt: {
      text,
      files: [{ uri: "file:///ignored" }],
      agents: [{ name: "ignored" }],
      skills: [{ id: "ignored" }],
    },
    delivery,
  });
}

async function reviewFailure(context: TestContext): Promise<Error> {
  const failure = await runReview(context, "").then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(failure instanceof Error)) throw new Error("review did not throw an error");
  return failure;
}

function initRepository(directory: string) {
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "add", "."], {
    cwd: directory,
  });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"],
    { cwd: directory },
  );
}

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
    expect(plugin.id).toBe("capybearista.opencode-adversarial-review");
    expect(plugin.setup).toBeFunction();
    expect("server" in plugin).toBe(false);
    expect("tui" in plugin).toBe(false);
  });

  test("package.json targets the V2 package root and has no TUI metadata", async () => {
    const manifest = await Bun.file(join(import.meta.dirname, "..", "package.json")).json();
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.exports["."].default).toBe("./dist/index.js");
    expect(manifest.files).toContain("server.js");
    expect(manifest.peerDependencies["@opencode/plugin"]).toBeString();
    expect(manifest.devDependencies["@opencode/plugin"]).toBeString();
    expect("oc-plugin" in manifest).toBe(false);
  });

  test("real V2 host resolves the package root server wrapper to the built entry", () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const child = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `
          import * as Host from "@opencode/plugin/host";
          const root = ${JSON.stringify(packageRoot)};
          const local = Host.resolve({ directory: root });
          const named = Host.resolve({ directory: root, name: "@capybearista/opencode-adversarial-review" });
          process.stdout.write(JSON.stringify({
            local: { server: local.server ?? null, tui: local.tui ?? null, rpc: local.rpc ?? null },
            named: { server: named.server ?? null, tui: named.tui ?? null, rpc: named.rpc ?? null },
          }));
        `,
      ],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr));
    }

    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
      local: {
        server: pathToFileURL(join(packageRoot, "server.js")).href,
        tui: null,
        rpc: null,
      },
      named: {
        server: pathToFileURL(join(packageRoot, "dist", "index.js")).href,
        tui: null,
        rpc: null,
      },
    });
  });

  test("setup registers the renamed reviewer agent and the review command", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.agents.has(COMMAND_NAME)).toBe(false);
    expect(context.commands.map((command) => command.name)).toEqual([COMMAND_NAME]);
    await cleanup?.();
  });

  test("reviewer agent runs as a hidden subagent", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const agent = context.agents.get(REVIEWER_AGENT_ID);
    expect(agent?.mode).toBe("subagent");
    expect(agent?.hidden).toBe(true);
  });

  test("reviewer description names the command path and is always enforced", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const description = context.agents.get(REVIEWER_AGENT_ID)?.description ?? "";
    expect(description).toInclude("Do not invoke adversarial-reviewer directly");
    expect(description).toInclude("/adversarial-review");
    expect(description).toInclude("only supported path");
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

  test("reviewer agent keeps the adversarial system prompt and appends the verbatim JSON rule", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const reference = await Bun.file(
      join(import.meta.dirname, "prompts", "adversarial-review.md"),
    ).text();
    const system = context.agents.get(REVIEWER_AGENT_ID)?.system ?? "";

    expect(system).toBe(
      `${reference.trimEnd()}\n\nReturn only valid JSON, verbatim. Do not wrap the JSON in markdown fences or add commentary outside the JSON object.`,
    );
    expect(system).toInclude("break confidence in the change");
    expect(system).toInclude("<attack_surface>");
    expect(system).toInclude("<finding_bar>");
    expect(system).toInclude("<structured_output_contract>");
    expect(system).toInclude("If the user supplied a focus area, weight it heavily");
    expect(system).toInclude("If `--scope auto` (the default)");
    expect(system).toInclude("review the working tree when it has staged or unstaged changes");
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

  test("reviewer permissions store no asks and evaluate to explicit allow or deny", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions.some((rule) => rule.effect === "ask")).toBe(false);

    const allowed: Array<[string, string]> = [
      ["read", "src/index.ts"],
      ["read", ".env.example"],
      ["glob", "**/*.ts"],
      ["grep", "src"],
      ["shell", "git blame src/index.ts"],
      ["shell", "git branch"],
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
  });

  test("execute treats a missing permissions array as empty when configuring the reviewer", async () => {
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

  test("reviewer cannot delegate work to any subagent", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect(context.agents.get(REVIEWER_AGENT_ID)?.permissions).toContainEqual({
      action: "subagent",
      resource: "*",
      effect: "deny",
    });
  });

  test("missing agent.transform is handled without throwing", async () => {
    const context = createTestContext();
    (context.ctx.agent as { transform?: unknown }).transform = undefined;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await setupPlugin(context);

    expect(context.commands.map((command) => command.name)).toEqual([COMMAND_NAME]);
    expect(context.agents.size).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "[capybearista.opencode-adversarial-review] agent.transform is unavailable; adversarial-reviewer was not registered",
    );
    errorSpy.mockRestore();
    await cleanup?.();
  });

  test("setup diagnostics prefer a host structured log sink", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const context = createTestContext({
      hostLog: (input) => {
        entries.push(input);
      },
    });
    (context.ctx.agent as { transform?: unknown }).transform = undefined;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await setupPlugin(context);

    expect(entries).toContainEqual({
      service: "capybearista.opencode-adversarial-review",
      level: "error",
      message:
        "[capybearista.opencode-adversarial-review] agent.transform is unavailable; adversarial-reviewer was not registered",
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
    (context.ctx.agent as { transform?: unknown }).transform = undefined;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await setupPlugin(context);

    expect(errorSpy).toHaveBeenCalledWith(
      "[capybearista.opencode-adversarial-review] agent.transform is unavailable; adversarial-reviewer was not registered",
    );
    errorSpy.mockRestore();
    await cleanup?.();
  });

  test("missing session.hook is handled without throwing", async () => {
    const context = createTestContext();
    (context.ctx.session as { hook?: unknown }).hook = undefined;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    errorSpy.mockRestore();
    await cleanup?.();
  });

  test("missing command.transform is handled without throwing", async () => {
    const context = createTestContext();
    (context.ctx.command as { transform?: unknown }).transform = undefined;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.commands).toHaveLength(0);
    errorSpy.mockRestore();
    await cleanup?.();
  });

  test("command description folds the old argument hint in", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const description = context.commands[0]?.description ?? "";
    expect(description).toInclude("[--base <ref>]");
    expect(description).toInclude("[--scope auto|working-tree|branch]");
    expect(description).toInclude("[focus ...]");
  });

  test("execute creates a root reviewer session and forwards only raw prompt text", async () => {
    const context = createTestContext({ assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);

    await runReview(context, "--scope working-tree check auth", "queue");

    expect(context.created).toHaveLength(1);
    const created = context.created[0];
    expect(created?.agent).toBe(REVIEWER_AGENT_ID);
    expect(created?.parentID).toBeUndefined();
    expect(created?.id).toBe("ses_review_1");
    expect(context.prompts).toHaveLength(1);
    const prompt = context.prompts[0] ?? {};
    expect(prompt.sessionID).toBe("ses_review_1");
    expect(prompt.text).toInclude("Arguments: --scope working-tree check auth");
    expect(prompt.files).toBeUndefined();
    expect(prompt.agents).toBeUndefined();
    expect(prompt.skills).toBeUndefined();
    expect(context.waits).toEqual(["ses_review_1"]);
    expect(context.synthetics[0]?.sessionID).toBe("ses_caller");
    expect(context.synthetics[0]?.delivery).toBe("queue");
  });

  test("execute inherits the invoking session's model", async () => {
    const context = createTestContext({ assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.sessionGets).toEqual(["ses_caller"]);
    expect(context.created[0]?.model).toEqual(CALLER_MODEL);
  });

  test("execute inherits the invoking session's model variant verbatim", async () => {
    const callerModel: TestModel = {
      providerID: "caller-provider",
      id: "caller-model",
      variant: "careful",
    };
    const context = createTestContext({ callerModel, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.sessionGets).toEqual(["ses_caller"]);
    expect(context.created[0]?.model).toEqual(callerModel);
  });

  test("execute applies an explicit plugin model option over the caller model", async () => {
    const context = createTestContext({
      options: { model: "anthropic/claude-haiku-4-20250514" },
      callerModel: { providerID: "other-provider", id: "other-model", variant: "other-variant" },
      assistantText: VALID_REVIEW_JSON,
    });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.sessionGets).toEqual([]);
    expect(context.created[0]?.model).toEqual({
      providerID: "anthropic",
      id: "claude-haiku-4-20250514",
    });
  });

  test("execute preserves an explicit plugin model variant", async () => {
    const context = createTestContext({
      options: { model: "openrouter/openai/gpt-5-mini#fast" },
      assistantText: VALID_REVIEW_JSON,
    });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.created[0]?.model).toEqual({
      providerID: "openrouter",
      id: "openai/gpt-5-mini",
      variant: "fast",
    });
  });

  test("execute trims whitespace around the plugin model option", async () => {
    const context = createTestContext({
      options: { model: "  anthropic/claude-haiku-4-20250514  " },
      assistantText: VALID_REVIEW_JSON,
    });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.created[0]?.model).toEqual({
      providerID: "anthropic",
      id: "claude-haiku-4-20250514",
    });
  });

  test("execute rejects invalid explicit model options before creating anything", async () => {
    const cases: unknown[] = [
      42,
      null,
      "",
      "   ",
      "no-provider",
      "anthropic/",
      "anthropic/claude#",
      "anthropic/claude#first#second",
      "anthropic#tag/claude",
    ];
    for (const model of cases) {
      const context = createTestContext({ options: { model } });
      await setupPlugin(context);

      await expect(runReview(context, "")).rejects.toThrow(/Invalid model option/);
      expect(context.created).toHaveLength(0);
      expect(context.prompts).toHaveLength(0);
      expect(context.synthetics).toHaveLength(0);
      expect(context.sessionGets).toHaveLength(0);
    }
  });

  test("execute fails before creating anything when the caller session has no model", async () => {
    const context = createTestContext({ callerModel: null, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);

    await expect(runReview(context, "")).rejects.toThrow(
      /The invoking session "ses_caller" has no model\. Select a model there or configure options\.model\./,
    );
    expect(context.sessionGets).toEqual(["ses_caller"]);
    expect(context.created).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute preserves the cause when the caller session lookup rejects", async () => {
    const lookupError = new Error("session store offline");
    const context = createTestContext({
      sessionGetError: lookupError,
      assistantText: VALID_REVIEW_JSON,
    });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude('Unable to read the invoking session "ses_caller"');
    expect(failure.message).toInclude("session store offline");
    expect(failure.message).toInclude("Select a model there or configure options.model.");
    expect(failure.cause).toBe(lookupError);
    expect(context.created).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute collects the full git context from the plugin location", async () => {
    const directory = await temporaryDirectory("adversarial-review-repo-");
    await writeFile(join(directory, "a.txt"), "one\n");
    initRepository(directory);
    await writeFile(join(directory, "a.txt"), "two\n");
    await writeFile(join(directory, "b.txt"), "untracked contents\n");

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "focus on rollbacks");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("## Git Context");
    expect(text).toInclude("=== Branch ===");
    expect(text).toInclude("=== Status ===");
    expect(text).toInclude(" M a.txt");
    expect(text).toInclude("=== Recent Commits ===");
    expect(text).toInclude("init");
    expect(text).toInclude("=== Full Diff ===");
    expect(text).toInclude("+two");
    expect(text).toInclude("=== Untracked File Contents ===");
    expect(text).toInclude("--- b.txt ---");
    expect(text).toInclude("untracked contents");
    expect(text).toInclude("focus on rollbacks");
  });

  test("execute inlines a diff larger than the old stat fallback budget", async () => {
    const directory = await temporaryDirectory("adversarial-review-bigdiff-");
    await writeFile(join(directory, "big.txt"), "start\n");
    initRepository(directory);
    await writeFile(join(directory, "big.txt"), `${"x".repeat(96 * 1024)}\nDIFF_TAIL_SENTINEL\n`);

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("=== Full Diff ===");
    expect(text).toInclude("DIFF_TAIL_SENTINEL");
    expect(text).not.toInclude("=== Diff Stat ===");
    expect(text).not.toInclude("diff truncated");
    expect(text.length).toBeGreaterThan(96 * 1024);
  });

  test("execute inlines git output past the old 10MB buffer ceiling", async () => {
    const directory = await temporaryDirectory("adversarial-review-huge-");
    await writeFile(join(directory, "huge.txt"), "start\n");
    initRepository(directory);
    const padding = 11 * 1024 * 1024;
    await writeFile(join(directory, "huge.txt"), `${"y".repeat(padding)}\nHUGE_TAIL_SENTINEL\n`);

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("=== Full Diff ===");
    expect(text).toInclude("HUGE_TAIL_SENTINEL");
    expect(text).not.toInclude("diff truncated");
    expect(text.length).toBeGreaterThan(10 * 1024 * 1024);
  });

  test("execute inlines every changed file regardless of count", async () => {
    const directory = await temporaryDirectory("adversarial-review-many-");
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(directory, `file-${index}.txt`), "base\n");
    }
    initRepository(directory);
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(directory, `file-${index}.txt`), `changed-${index}\n`);
    }

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("=== Full Diff ===");
    for (let index = 0; index < 8; index += 1) {
      expect(text).toInclude(`file-${index}.txt`);
      expect(text).toInclude(`+changed-${index}`);
    }
    expect(text).not.toInclude("=== Diff Stat ===");
  });

  test("execute inlines every untracked file regardless of count", async () => {
    const directory = await temporaryDirectory("adversarial-review-untracked-");
    await writeFile(join(directory, "tracked.txt"), "tracked\n");
    initRepository(directory);
    for (let index = 0; index < 7; index += 1) {
      await writeFile(join(directory, `untracked-${index}.txt`), `untracked-body-${index}\n`);
    }

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    for (let index = 0; index < 7; index += 1) {
      expect(text).toInclude(`--- untracked-${index}.txt ---`);
      expect(text).toInclude(`untracked-body-${index}`);
    }
  });

  test("execute inlines untracked files past the old per-file head cap", async () => {
    const directory = await temporaryDirectory("adversarial-review-largefile-");
    await writeFile(join(directory, "tracked.txt"), "tracked\n");
    initRepository(directory);
    await writeFile(
      join(directory, "large.txt"),
      `${"z".repeat(64 * 1024)}\nUNTRACKED_TAIL_SENTINEL\n`,
    );

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("--- large.txt ---");
    expect(text).toInclude("UNTRACKED_TAIL_SENTINEL");
    expect(text.length).toBeGreaterThan(64 * 1024);
  });

  test("execute inlines untracked files whose names contain newlines", async () => {
    const directory = await temporaryDirectory("adversarial-review-newline-");
    await writeFile(join(directory, "tracked.txt"), "tracked\n");
    initRepository(directory);
    await writeFile(join(directory, "line one\nline two.txt"), "newline filename body\n");

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("newline filename body");
    expect(text).toInclude("--- line one");
  });

  test("execute reports staged changes in the full diff", async () => {
    const directory = await temporaryDirectory("adversarial-review-staged-");
    await writeFile(join(directory, "staged.txt"), "base\n");
    initRepository(directory);
    await writeFile(join(directory, "staged.txt"), "staged-change\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: directory });

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("=== Full Diff ===");
    expect(text).toInclude("+staged-change");
  });

  test("execute includes the current branch in the git context", async () => {
    const directory = await temporaryDirectory("adversarial-review-branch-");
    await writeFile(join(directory, "branch.txt"), "base\n");
    initRepository(directory);
    execFileSync("git", ["checkout", "-q", "-b", "feature/context-branch"], { cwd: directory });

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("=== Branch ===");
    expect(text).toInclude("feature/context-branch");
  });

  test("execute reports git failures for an empty repository instead of failing", async () => {
    const directory = await temporaryDirectory("adversarial-review-emptydiff-");
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "fresh.txt"), "fresh\n");

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("=== Full Diff ===");
    expect(text).toMatch(/fatal|HEAD/);
    expect(text).not.toInclude("=== Diff Stat ===");
    expect(context.synthetics[0]?.text).toBe(VALID_REVIEW_JSON);
  });

  test("collectGitContext reports a bounded timeout", async () => {
    const directory = await temporaryDirectory("adversarial-review-timeout-");

    const text = await collectGitContext(directory, 1);

    expect(text).toInclude("timed out after 1ms");
    expect(text).toInclude("=== Full Diff ===");
    expect(text).toInclude("=== Untracked File Contents ===");
  });

  test("collectGitContext reports signal termination by name", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory("adversarial-review-signal-");
    const bin = await temporaryDirectory("adversarial-review-bin-");
    await writeFile(join(bin, "git"), "#!/bin/sh\nkill -TERM $$\n");
    await chmod(join(bin, "git"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const text = await collectGitContext(directory);
      expect(text).toInclude("was terminated by SIGTERM");
      expect(text).toInclude("=== Full Diff ===");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  test("untracked content skips entries whose resolved path escapes the repository", async () => {
    const outside = await temporaryDirectory("adversarial-review-outside-");
    await writeFile(join(outside, "secret.txt"), "outside secret\n");
    const directory = await temporaryDirectory("adversarial-review-escape-");
    await writeFile(join(directory, "tracked.txt"), "tracked\n");
    initRepository(directory);
    await symlink(join(outside, "secret.txt"), join(directory, "link.txt"));

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).not.toInclude("outside secret");
    expect(text).not.toInclude("--- link.txt ---");
  });

  test("untracked content skips binary files", async () => {
    const directory = await temporaryDirectory("adversarial-review-binary-");
    await writeFile(join(directory, "tracked.txt"), "tracked\n");
    initRepository(directory);
    await writeFile(join(directory, "image.bin"), Buffer.from([0x00, 0x01, 0xff, 0xfe]));
    await writeFile(join(directory, "notes.txt"), "text notes\n");

    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);
    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("--- notes.txt ---");
    expect(text).toInclude("text notes");
    expect(text).not.toInclude("--- image.bin ---");
  });

  test("execute treats a missing repository as context instead of failing", async () => {
    const directory = await temporaryDirectory("adversarial-review-norepo-");
    const context = createTestContext({ directory, assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);

    await runReview(context, "");

    const text = String(context.prompts[0]?.text ?? "");
    expect(text).toInclude("=== Branch ===");
    expect(text).toInclude("not a git repository");
    expect(context.synthetics).toHaveLength(1);
  });

  test("execute falls back to the project directory when the location directory is empty", async () => {
    const directory = await temporaryDirectory("adversarial-review-project-");
    await writeFile(join(directory, "a.txt"), "one\n");
    initRepository(directory);

    const context = createTestContext({
      directory: "",
      projectDirectory: directory,
      assistantText: VALID_REVIEW_JSON,
    });
    await setupPlugin(context);
    await runReview(context, "");

    expect(context.created[0]?.location).toEqual({ directory });
    expect(String(context.prompts[0]?.text)).toInclude("init");
  });

  test("execute forwards valid review JSON verbatim to the invocation session", async () => {
    const reviewerOutput = '{"verdict":"approve","summary":"safe","findings":[],"next_steps":[]}';
    const context = createTestContext({ assistantText: reviewerOutput });
    await setupPlugin(context);

    await runReview(context, "check auth", "steer");

    expect(context.synthetics[0]?.text).toBe(reviewerOutput);
    expect(context.synthetics[0]?.resume).toBe(false);
    expect(context.synthetics[0]?.metadata).toEqual({
      source: "capybearista.opencode-adversarial-review",
      sessionID: "ses_review_1",
    });
  });

  test("execute forwards the original reviewer text byte-for-byte", async () => {
    const reviewerOutput = `\n\n${VALID_REVIEW_JSON}\n`;
    const context = createTestContext({ assistantText: reviewerOutput });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.synthetics[0]?.text).toBe(reviewerOutput);
  });

  test("execute rejects an empty review session with empty-output", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude(`${REVIEW_FAILURE_PREFIX} [empty-output]`);
    expect(failure.message).toInclude("review session ses_review_1");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute rejects whitespace-only assistant text", async () => {
    const context = createTestContext({ assistantText: "   \n  " });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[empty-output]");
    expect(failure.message).toInclude("produced no assistant text output");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute rejects reasoning-only output without falling back", async () => {
    const context = createTestContext({
      assistantContent: [
        { type: "reasoning", text: "first thought" },
        { type: "reasoning", text: "  final thought  " },
      ],
    });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[empty-output]");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute validates only the latest assistant message", async () => {
    const context = createTestContext({
      assistantMessages: [
        { content: [{ type: "text", text: "not json at all" }] },
        { content: [{ type: "text", text: VALID_REVIEW_JSON }] },
      ],
    });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.synthetics[0]?.text).toBe(VALID_REVIEW_JSON);
  });

  test("execute rejects an empty latest assistant message even when older ones are valid", async () => {
    const context = createTestContext({
      assistantMessages: [
        { content: [{ type: "text", text: VALID_REVIEW_JSON }] },
        { content: [{ type: "text", text: "   " }] },
      ],
    });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[empty-output]");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute categorizes a malformed assistant content field", async () => {
    const cases: unknown[] = ["not-an-array", undefined, 42, null];
    for (const content of cases) {
      const context = createTestContext({
        assistantMessages: [{ content: content as Array<Record<string, unknown>> }],
      });
      await setupPlugin(context);

      const failure = await reviewFailure(context);

      expect(failure.message).toInclude("[session-failed]");
      expect(failure.message).toInclude(
        "returned a malformed assistant message: content is missing or not an array",
      );
      expect(context.synthetics).toHaveLength(0);
    }
  });

  test("execute ignores malformed text parts instead of crashing", async () => {
    const context = createTestContext({
      assistantContent: [null as unknown as Record<string, unknown>, { type: "text", text: 42 }],
    });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[empty-output]");
    expect(failure.message).toInclude("produced no assistant text output");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute rejects prose output as invalid JSON", async () => {
    const context = createTestContext({ assistantText: "looks good to me" });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[invalid-json]");
    expect(failure.message).toInclude("returned invalid JSON");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute rejects markdown-fenced JSON", async () => {
    const context = createTestContext({
      assistantText: `\`\`\`json\n${VALID_REVIEW_JSON}\n\`\`\``,
    });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[invalid-json]");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute rejects truncated JSON", async () => {
    const context = createTestContext({ assistantText: '{"verdict":"approve"' });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[invalid-json]");
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute rejects schema violations with a precise diagnostic path", async () => {
    const validFindings = [
      {
        severity: "high",
        title: "title",
        body: "body",
        file: "src/index.ts",
        line_start: 1,
        line_end: 2,
        confidence: 0.5,
        recommendation: "fix it",
      },
    ];
    const cases: Array<{ output: unknown; pattern: RegExp }> = [
      {
        output: { verdict: "approve", summary: "ok", findings: [] },
        pattern: /missing required key "next_steps"/,
      },
      {
        output: { verdict: "approve", summary: "ok", findings: [], next_steps: [], extra: 1 },
        pattern: /unexpected key "extra"/,
      },
      {
        output: { verdict: "maybe", summary: "ok", findings: [], next_steps: [] },
        pattern: /\$\.verdict must be one of/,
      },
      {
        output: { verdict: "approve", summary: "", findings: [], next_steps: [] },
        pattern: /\$\.summary must be at least 1 character/,
      },
      {
        output: { verdict: "approve", summary: "   ", findings: [], next_steps: [] },
        pattern: /\$\.summary must not be blank/,
      },
      {
        output: { verdict: "approve", summary: "ok", findings: {}, next_steps: [] },
        pattern: /\$\.findings must be an array/,
      },
      {
        output: {
          verdict: "approve",
          summary: "ok",
          findings: [{ ...validFindings[0], confidence: 1.5 }],
          next_steps: [],
        },
        pattern: /\$\.findings\[0\]\.confidence must be <= 1/,
      },
      {
        output: {
          verdict: "approve",
          summary: "ok",
          findings: [{ ...validFindings[0], line_start: 0 }],
          next_steps: [],
        },
        pattern: /\$\.findings\[0\]\.line_start must be >= 1/,
      },
      {
        output: {
          verdict: "approve",
          summary: "ok",
          findings: [{ ...validFindings[0], line_end: 1.5 }],
          next_steps: [],
        },
        pattern: /\$\.findings\[0\]\.line_end must be an integer/,
      },
      {
        output: { verdict: "approve", summary: "ok", findings: [], next_steps: [42] },
        pattern: /\$\.next_steps\[0\] must be a string/,
      },
    ];
    for (const { output, pattern } of cases) {
      const context = createTestContext({ assistantText: JSON.stringify(output) });
      await setupPlugin(context);

      const failure = await reviewFailure(context);

      expect(failure.message).toInclude("[schema-violation]");
      expect(failure.message).toMatch(pattern);
      expect(context.synthetics).toHaveLength(0);
    }
  });

  test("execute accepts findings and next_steps with full field sets", async () => {
    const output = {
      verdict: "needs-attention",
      summary: "one issue",
      findings: [
        {
          severity: "critical",
          title: "data loss",
          body: "body",
          file: "src/index.ts",
          line_start: 1,
          line_end: 3,
          confidence: 0,
          recommendation: "fix",
        },
      ],
      next_steps: ["add a test"],
    };
    const context = createTestContext({ assistantText: JSON.stringify(output) });
    await setupPlugin(context);

    await runReview(context, "");

    expect(context.synthetics[0]?.text).toBe(JSON.stringify(output));
  });

  test("execute rejects an errored assistant message before reading its text", async () => {
    const sessionError = { type: "api_error", message: "provider exploded", status: 500 };
    const context = createTestContext({
      assistantMessages: [
        { content: [{ type: "text", text: VALID_REVIEW_JSON }], error: sessionError },
      ],
    });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[session-failed]");
    expect(failure.message).toInclude("api_error (500): provider exploded");
    expect(failure.cause).toBe(sessionError);
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute reports a failed review session create with a not-created diagnostic", async () => {
    const createError = new Error("boom");
    const context = createTestContext({ createError });
    await setupPlugin(context);

    const failure = await reviewFailure(context);

    expect(failure.message).toInclude("[session-failed]");
    expect(failure.message).toInclude("review session was not created: boom");
    expect(failure.cause).toBe(createError);
    expect(context.prompts).toHaveLength(0);
    expect(context.synthetics).toHaveLength(0);
  });

  test("execute preserves the cause of every review session stage failure", async () => {
    const stages: Array<["promptError" | "waitError" | "contextError" | "syntheticError", string]> =
      [
        ["promptError", "prompt"],
        ["waitError", "wait"],
        ["contextError", "context"],
        ["syntheticError", "delivery"],
      ];
    for (const [optionKey, stage] of stages) {
      const stageError = new Error(`${stage} exploded`);
      const context = createTestContext({
        assistantText: VALID_REVIEW_JSON,
        [optionKey]: stageError,
      });
      await setupPlugin(context);

      const failure = await reviewFailure(context);

      expect(failure.message).toInclude("[session-failed]");
      expect(failure.message).toInclude(`review session ses_review_1 ${stage} failed`);
      expect(failure.cause).toBe(stageError);
      expect(context.synthetics).toHaveLength(0);
    }
  });

  test("review temperature is pinned to the active review session only", async () => {
    const context = createTestContext({ assistantText: VALID_REVIEW_JSON });
    await setupPlugin(context);

    expect([...context.hooks.keys()].sort()).toEqual(["context", "generate"]);

    await runReview(context, "focus");
    expect(context.hookEvents.map((entry) => entry.name).sort()).toEqual(["context", "generate"]);
    for (const entry of context.hookEvents) {
      expect(entry.event.options.temperature).toBe(0.1);
    }

    const foreign: HookEvent = { sessionID: "ses_other", options: {} };
    context.hooks.get("context")?.(foreign);
    expect(foreign.options.temperature).toBeUndefined();
  });

  test("cleanup disposes every registration", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    await cleanup?.();

    expect(context.disposers.sort()).toEqual(["agent", "command", "hook:context", "hook:generate"]);
  });

  test("output schema keeps the review contract", async () => {
    const text = await Bun.file(
      join(import.meta.dirname, "schemas", "review-output.schema.json"),
    ).text();
    const schema = JSON.parse(text);

    expect(schema.required).toEqual(["verdict", "summary", "findings", "next_steps"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.verdict.enum).toEqual(["approve", "needs-attention"]);

    const finding = schema.properties.findings.items;
    expect(finding.required).toEqual([
      "severity",
      "title",
      "body",
      "file",
      "line_start",
      "line_end",
      "confidence",
      "recommendation",
    ]);
    expect(finding.properties.severity.enum).toEqual(["critical", "high", "medium", "low"]);
    expect(finding.properties.confidence.minimum).toBe(0);
    expect(finding.properties.confidence.maximum).toBe(1);
    expect(finding.properties.line_start.minimum).toBe(1);
    expect(finding.properties.line_end.minimum).toBe(1);
  });
});
