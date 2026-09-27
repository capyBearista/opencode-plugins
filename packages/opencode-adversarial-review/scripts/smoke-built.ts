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

type SmokeLog = { level?: string; message?: string };

const ADVERSARIAL_REVIEWER_DESCRIPTION =
  "Do not invoke this agent directly. It is the adversarial code-review agent, invocable only by the user.";
const CONSTRUCTIVE_REVIEWER_DESCRIPTION =
  "Do not invoke this agent directly. It is the constructive code-review agent, invocable only by the user.";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

// Local approximation of host rule matching: `*` wildcards, backslash
// normalization, and the host's optional trailing " .*" argument form,
// evaluated last-match-wins. Mirrors the matcher in src/index.test.ts; the host
// remains authoritative at runtime.
function matches(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
}

function effectiveEffect(
  permissions: readonly PermissionRule[],
  action: string,
  resource: string,
): string {
  for (let index = permissions.length - 1; index >= 0; index -= 1) {
    const rule = permissions[index];
    if (rule && matches(action, rule.action) && matches(resource, rule.resource)) {
      return rule.effect;
    }
  }
  return "ask";
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
    command: {
      transform: async () => {
        commandTransforms += 1;
        return { dispose: async () => {} };
      },
    },
  });

  const reviewCommands = [
    ["adversarial-reviewer", "adversarial-review.md", ADVERSARIAL_REVIEWER_DESCRIPTION],
    ["constructive-reviewer", "constructive-review.md", CONSTRUCTIVE_REVIEWER_DESCRIPTION],
  ] as const;

  function assertReviewerContract(
    agent: TestAgent | undefined,
    agentId: string,
    description: string,
  ): void {
    assert(agent !== undefined, `${agentId} agent was not registered`);
    assert(agent.mode === "subagent", `${agentId} agent is not a subagent`);
    assert(agent.hidden === true, `${agentId} agent is not hidden`);
    assert(
      agent.description === description,
      `${agentId} description does not match the static do-not-invoke text`,
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
      hasRule({ action: "shell", resource: "gh pr view*", effect: "allow" }),
      `${agentId} gh pr view allow rule is missing`,
    );
    assert(
      hasRule({ action: "shell", resource: "gh pr diff*", effect: "allow" }),
      `${agentId} gh pr diff allow rule is missing`,
    );
    assert(
      hasRule({ action: "shell", resource: "gh *", effect: "deny" }),
      `${agentId} gh catch-all deny rule is missing`,
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

    const indexOfRule = (expected: PermissionRule) =>
      permissions.findIndex(
        (rule) =>
          rule.action === expected.action &&
          rule.resource === expected.resource &&
          rule.effect === expected.effect,
      );
    assert(
      hasRule({ action: "shell", resource: "git remote -v*", effect: "allow" }),
      `${agentId} narrowed git remote allow rule is missing`,
    );
    assert(
      hasRule({ action: "shell", resource: "gh auth status*", effect: "allow" }),
      `${agentId} gh auth status allow rule is missing`,
    );
    assert(
      !hasRule({ action: "shell", resource: "git remote *", effect: "allow" }),
      `${agentId} broad git remote allow rule must not be present`,
    );
    assert(
      !hasRule({ action: "shell", resource: "gh repo view*", effect: "allow" }),
      `${agentId} gh repo view allow rule must not be present`,
    );
    const ghCatchAll = indexOfRule({ action: "shell", resource: "gh *", effect: "deny" });
    const ghPrView = indexOfRule({ action: "shell", resource: "gh pr view*", effect: "allow" });
    const ghPrDiff = indexOfRule({ action: "shell", resource: "gh pr diff*", effect: "allow" });
    const ghAuthStatus = indexOfRule({
      action: "shell",
      resource: "gh auth status*",
      effect: "allow",
    });
    assert(
      ghCatchAll >= 0 && ghPrView > ghCatchAll && ghPrDiff > ghPrView && ghAuthStatus > ghPrDiff,
      `${agentId} gh rules are not ordered catch-all-deny then most-specific-allow`,
    );
    assert(
      indexOfRule({ action: "shell", resource: "gh auth status*--show-token*", effect: "deny" }) >
        ghAuthStatus &&
        indexOfRule({ action: "shell", resource: "gh auth status*-t*", effect: "deny" }) >
          ghAuthStatus,
      `${agentId} token-printing gh flags are not denied after the gh auth status allow`,
    );
    assert(
      effectiveEffect(permissions, "shell", "git remote -v") === "allow",
      `${agentId} git remote -v is not allowed`,
    );
    assert(
      effectiveEffect(permissions, "shell", "gh auth status") === "allow",
      `${agentId} bare gh auth status is not allowed`,
    );
    assert(
      effectiveEffect(permissions, "shell", "gh auth status --show-token") === "deny",
      `${agentId} gh auth status --show-token is not denied`,
    );
    assert(
      effectiveEffect(permissions, "shell", "gh auth status -t") === "deny",
      `${agentId} gh auth status -t is not denied`,
    );
  }

  assert(commandTransforms === 0, "the plugin registered a host command");
  for (const [agentId, commandFile, description] of reviewCommands) {
    assertReviewerContract(agents.get(agentId), agentId, description);
    assert(
      await Bun.file(join(configDir, "commands", commandFile)).exists(),
      `the ${commandFile} command was not installed into the isolated config directory`,
    );
  }

  assert(logs.length === 0, "setup logged diagnostics for a clean install");

  await cleanup?.();
  assert(
    disposers.sort().join(",") === "agent,agent",
    "cleanup missed a registration or registered a session hook",
  );

  process.stdout.write(
    "smoke: built server artifact loaded; both reviewer agents, permissions, installs, and agent-only disposers verified without session hooks\n",
  );
} finally {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  await rm(configDir, { recursive: true, force: true });
}
