import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cleanup = () => Promise<void> | void;

type PluginDefinition = {
  readonly id: string;
  readonly setup: (context: unknown) => Promise<Cleanup | undefined> | Cleanup | undefined;
};

type PermissionRule = { action: string; resource: string; effect: string };

type TestAgent = {
  id: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
  permissions: PermissionRule[];
};

type HookEvent = { sessionID: string; agent?: string; options: { temperature?: number } };

type SmokeLog = { level?: string; message?: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

const server = (await import(new URL("../server.js", import.meta.url).href)) as {
  default: PluginDefinition;
};

assert(server.default.id === "capybearista.opencode-adversarial-review", "server id mismatch");
assert(typeof server.default.setup === "function", "server setup is not a function");

const configDir = await mkdtemp(join(tmpdir(), "adversarial-review-smoke-"));
await mkdir(join(configDir, "commands"), { recursive: true });
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = configDir;

try {
  const agents = new Map<string, TestAgent>();
  const hooks = new Map<string, (event: HookEvent) => void>();
  const disposers: string[] = [];
  const logs: SmokeLog[] = [];
  let commandTransforms = 0;

  const cleanup = await server.default.setup({
    app: {
      name: "opencode",
      version: "smoke",
      channel: "smoke",
      log: (entry: SmokeLog) => {
        logs.push(entry);
      },
    },
    agent: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          list: () => [],
          get: () => undefined,
          update: (id: string, update: (agent: TestAgent) => void) => {
            const agent: TestAgent = { id, permissions: [] };
            update(agent);
            agents.set(id, agent);
          },
          remove: () => {},
          default: () => {},
        });
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
        commandTransforms += 1;
        return { dispose: async () => {} };
      },
    },
  });

  const reviewCommands = [
    ["adversarial-reviewer", "adversarial-review.md"],
    ["reviewer", "review.md"],
  ] as const;

  function assertReviewerContract(
    agent: TestAgent | undefined,
    agentId: string,
    commandFile: string,
  ): void {
    assert(agent !== undefined, `${agentId} agent was not registered`);
    assert(agent.mode === "subagent", `${agentId} agent is not a subagent`);
    assert(agent.hidden === true, `${agentId} agent is not hidden`);
    assert(
      (agent.description ?? "").includes(`Run /${commandFile.replace(/\.md$/, "")} instead`),
      `${agentId} description does not name its command`,
    );
    assert(
      (agent.description ?? "").includes(join("commands", commandFile)),
      `${agentId} description does not name the installed command template path`,
    );

    const permissions = agent.permissions ?? [];
    assert(
      permissions.every((rule) => rule.effect !== "ask"),
      `${agentId} permissions contain an ask rule`,
    );
    const hasRule = (expected: PermissionRule) =>
      permissions.some(
        (rule) =>
          rule.action === expected.action &&
          rule.resource === expected.resource &&
          rule.effect === expected.effect,
      );
    assert(
      hasRule({ action: "read", resource: "*", effect: "allow" }),
      `${agentId} read allow rule is missing`,
    );
    assert(
      hasRule({ action: "shell", resource: "git diff*", effect: "allow" }),
      `${agentId} git diff allow rule is missing`,
    );
    assert(
      hasRule({ action: "edit", resource: "*", effect: "deny" }),
      `${agentId} edit deny rule is missing`,
    );
    assert(
      hasRule({ action: "subagent", resource: "*", effect: "deny" }),
      `${agentId} subagent self-deny rule is missing`,
    );
    assert(
      hasRule({ action: "skill", resource: "*", effect: "deny" }),
      `${agentId} skill deny rule is missing`,
    );
    assert(
      hasRule({ action: "read", resource: "*.env", effect: "deny" }),
      `${agentId} env deny rule is missing`,
    );
    assert(
      hasRule({ action: "read", resource: "*.env.example", effect: "allow" }),
      `${agentId} env.example allow rule is missing`,
    );
    assert(
      hasRule({ action: "shell", resource: "git branch --show-current*", effect: "allow" }),
      `${agentId} narrowed git branch allow rule is missing`,
    );
    assert(
      hasRule({ action: "shell", resource: "git diff*--ext-diff*", effect: "deny" }),
      `${agentId} diff-engine deny rule is missing`,
    );
    assert(
      hasRule({ action: "grep", resource: "*.env", effect: "deny" }),
      `${agentId} grep env deny rule is missing`,
    );
    assert(
      hasRule({ action: "glob", resource: "*.env.example", effect: "allow" }),
      `${agentId} glob env.example allow rule is missing`,
    );
  }

  assert(commandTransforms === 0, "the plugin registered a host command");
  for (const [agentId, commandFile] of reviewCommands) {
    assertReviewerContract(agents.get(agentId), agentId, commandFile);
    assert(
      await Bun.file(join(configDir, "commands", commandFile)).exists(),
      `the ${commandFile} command was not installed into the isolated config directory`,
    );
  }

  assert(
    [...hooks.keys()].sort().join(",") === "context,generate",
    "temperature hooks are missing",
  );
  const reviewerEvent: HookEvent = {
    sessionID: "ses_smoke_review",
    agent: "adversarial-reviewer",
    options: {},
  };
  const reviewAgentEvent: HookEvent = {
    sessionID: "ses_smoke_agent_review",
    agent: "reviewer",
    options: {},
  };
  const foreignEvent: HookEvent = { sessionID: "ses_smoke_foreign", agent: "build", options: {} };
  const anonymousEvent: HookEvent = { sessionID: "ses_smoke_unknown", options: {} };
  for (const hook of hooks.values()) {
    hook(reviewerEvent);
    hook(reviewAgentEvent);
    hook(foreignEvent);
    hook(anonymousEvent);
  }
  assert(
    reviewerEvent.options.temperature === 0.1,
    "adversarial reviewer temperature was not pinned",
  );
  assert(reviewAgentEvent.options.temperature === 0.1, "review agent temperature was not pinned");
  assert(foreignEvent.options.temperature === undefined, "temperature leaked to a foreign agent");
  assert(
    anonymousEvent.options.temperature === undefined,
    "temperature leaked to an anonymous event",
  );
  const skipWarnings = logs.filter(
    (entry) => entry.level === "warn" && (entry.message ?? "").includes("temperature"),
  );
  assert(
    skipWarnings.length === 2,
    "temperature hook did not warn once per unattributable agent identity",
  );

  await cleanup?.();
  assert(
    disposers.sort().join(",") === "agent,agent,hook:context,hook:generate",
    "cleanup missed a registration",
  );

  process.stdout.write(
    "smoke: built server artifact loaded; both reviewer agents, permissions, installs, and reviewer-only hooks verified\n",
  );
} finally {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  await rm(configDir, { recursive: true, force: true });
}
