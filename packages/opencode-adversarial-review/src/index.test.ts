import { describe, expect, mock, test } from "bun:test";
import { join } from "path";
import plugin from "./index.js";

describe("@capybearista/opencode-adversarial-review", () => {
  test("has a plugin id", () => {
    expect(plugin.id).toBeString();
    expect(plugin.id).toBe("capybearista.opencode-adversarial-review");
  });

  test("exports a default object", () => {
    expect(plugin).toBeObject();
  });

  test("exports server hooks", () => {
    expect(plugin.server).toBeFunction();
  });

  test("config hook registers adversarial-review agent when not present", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.agent).toBeDefined();
    expect(cfg.agent["adversarial-review"]).toBeDefined();
    expect(cfg.agent["adversarial-review"].mode).toBe("subagent");
    expect(cfg.agent["adversarial-review"].model).toBe("openai/gpt-5.4");
    expect(cfg.agent["adversarial-review"].prompt).toBeTruthy();
    expect(cfg.agent["adversarial-review"].prompt).toInclude("break confidence in the change");
    expect(cfg.agent["adversarial-review"].permission.edit).toBe("deny");
    expect(cfg.agent["adversarial-review"].permission.bash["git diff*"]).toBe("allow");
    expect(cfg.agent["adversarial-review"].permission.webfetch).toBe("deny");
  });

  test("config hook registers adversarial-review command when not present", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.command).toBeDefined();
    expect(cfg.command["adversarial-review"]).toBeDefined();
    expect(cfg.command["adversarial-review"].agent).toBe("adversarial-review");
    expect(cfg.command["adversarial-review"].subtask).toBe(true);
    expect(cfg.command["adversarial-review"].template).toBeTruthy();
    expect(cfg.command["adversarial-review"].template).toInclude("$ARGUMENTS");
    expect(cfg.command["adversarial-review"].template).toInclude("git branch");
  });

  test("config hook does not overwrite existing agent", async () => {
    const cfg: Record<string, any> = {
      agent: {
        "adversarial-review": {
          description: "custom agent",
          mode: "subagent",
          model: "anthropic/claude-haiku-4-20250514",
          prompt: "custom prompt",
        },
      },
    };
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.agent["adversarial-review"].model).toBe("anthropic/claude-haiku-4-20250514");
    expect(cfg.agent["adversarial-review"].prompt).toBe("custom prompt");
  });

  test("config hook fills in missing fields when user provides partial agent config", async () => {
    const cfg: Record<string, any> = {
      agent: {
        "adversarial-review": {
          model: "openrouter/openai/gpt-5-mini",
        },
      },
    };
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    const agent = cfg.agent["adversarial-review"];
    expect(agent.model).toBe("openrouter/openai/gpt-5-mini");
    expect(agent.prompt).toInclude("break confidence in the change");
    expect(agent.mode).toBe("subagent");
    expect(agent.description).toBeTruthy();
    expect(agent.temperature).toBe(0.1);
    expect(agent.color).toBe("warning");
    expect(agent.permission.edit).toBe("deny");
    expect(agent.permission.bash["git diff*"]).toBe("allow");
    expect(agent.permission.bash["*"]).toBe("deny");
    expect(agent.permission.webfetch).toBe("deny");
  });

  test("config hook does not overwrite existing command", async () => {
    const cfg: Record<string, any> = {
      command: {
        "adversarial-review": {
          template: "custom template",
          agent: "custom-agent",
        },
      },
    };
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.command["adversarial-review"].template).toBe("custom template");
    expect(cfg.command["adversarial-review"].agent).toBe("custom-agent");
  });

  test("config hook preserves unrelated user agents and commands", async () => {
    const cfg: Record<string, any> = {
      agent: {
        "existing-agent": {
          mode: "primary",
          model: "openai/gpt-5.4",
        },
      },
      command: {
        "existing-cmd": {
          template: "do something",
        },
      },
    };
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.agent["existing-agent"]).toBeDefined();
    expect(cfg.command["existing-cmd"]).toBeDefined();
    expect(cfg.agent["adversarial-review"]).toBeDefined();
    expect(cfg.command["adversarial-review"]).toBeDefined();
  });

  test("config hook is idempotent — calling twice preserves user override", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);

    await hooks.config(cfg);
    cfg.agent["adversarial-review"].model = "anthropic/claude-sonnet-4-20250514";

    await hooks.config(cfg);
    expect(cfg.agent["adversarial-review"].model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("config hook handles null agent gracefully", async () => {
    const cfg: Record<string, any> = { agent: null };
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.agent).toBeDefined();
    expect(cfg.agent["adversarial-review"]).toBeDefined();
  });

  test("config hook handles null command gracefully", async () => {
    const cfg: Record<string, any> = { command: null };
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.command).toBeDefined();
    expect(cfg.command["adversarial-review"]).toBeDefined();
  });

  test("config hook initializes agent and command objects if absent", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.agent).toBeDefined();
    expect(cfg.command).toBeDefined();
  });

  test("agent prompt contains structured output contract", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    const prompt = cfg.agent["adversarial-review"].prompt;
    expect(prompt).toInclude("structured_output_contract");
    expect(prompt).toInclude("verdict");
    expect(prompt).toInclude("needs-attention");
    expect(prompt).toInclude("severity");
    expect(prompt).toInclude("line_start");
    expect(prompt).toInclude("line_end");
  });

  test("command template includes shell injection markers", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    const template = cfg.command["adversarial-review"].template;
    expect(template).toInclude("Arguments: $ARGUMENTS");
    expect(template).toInclude("git log");
    expect(template).toInclude("git status");
    expect(template).toInclude("git diff");
  });

  test("agent permission denies edit and restricts bash to read-only git subcommands", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    const permission = cfg.agent["adversarial-review"].permission;
    expect(permission.edit).toBe("deny");

    const allowed = permission.bash;
    expect(allowed["git diff*"]).toBe("allow");
    expect(allowed["git log*"]).toBe("allow");
    expect(allowed["git status*"]).toBe("allow");
    expect(allowed["git show*"]).toBe("allow");
    expect(allowed["git rev-parse*"]).toBe("allow");
    expect(allowed["git branch"]).toBe("allow");
    expect(allowed["git ls-files*"]).toBe("allow");
    expect(allowed["git merge-base*"]).toBe("allow");
    expect(allowed["git rev-list*"]).toBe("allow");
    expect(allowed["git stash list*"]).toBe("allow");
    expect(allowed["git stash show*"]).toBe("allow");
    expect(allowed["git blame*"]).toBe("allow");
    expect(allowed["*"]).toBe("deny");
    expect(permission.webfetch).toBe("deny");
  });

  test("agent has temperature and color configured", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);

    expect(cfg.agent["adversarial-review"].temperature).toBe(0.1);
    expect(cfg.agent["adversarial-review"].color).toBe("warning");
  });

  test("embedded prompt matches reference prompt file", async () => {
    const cfg: Record<string, any> = {};
    const hooks = await plugin.server({} as any);
    await hooks.config(cfg);
    const embedded = cfg.agent["adversarial-review"].prompt;

    const reference = await Bun.file(
      join(import.meta.dirname, "prompts", "adversarial-review.md"),
    ).text();
    expect(embedded.trim()).toBe(reference.trim());
  });

  test("output schema is valid JSON with required fields", async () => {
    const text = await Bun.file(
      join(import.meta.dirname, "schemas", "review-output.schema.json"),
    ).text();
    const schema = JSON.parse(text);

    expect(schema.required).toContain("verdict");
    expect(schema.required).toContain("findings");
    expect(schema.properties.verdict.enum).toEqual(["approve", "needs-attention"]);

    const findingProps = schema.properties.findings.items.properties;
    expect(findingProps.severity.enum).toEqual(["critical", "high", "medium", "low"]);
    expect(findingProps.confidence.minimum).toBe(0);
    expect(findingProps.confidence.maximum).toBe(1);
    expect(findingProps.line_start.minimum).toBe(1);
    expect(findingProps.line_end.minimum).toBe(1);
  });

  test("hooks are registered", async () => {
    const hooks = await plugin.server({} as any);
    expect(hooks["chat.message"]).toBeFunction();
    expect(hooks["tool.execute.after"]).toBeFunction();
  });

  test("chat.message hook no-ops when reviewGate is not enabled (default)", async () => {
    const commandSpy = mock(async () => {});
    const hooks = await plugin.server({
      client: { session: { command: commandSpy } },
    } as any);

    await hooks["chat.message"](
      { sessionID: "s1", agent: "primary" } as any,
      { message: {}, parts: [] } as any,
    );

    expect(commandSpy).toHaveBeenCalledTimes(0);
  });

  test("chat.message hook no-ops when config is null (no experimental set)", async () => {
    const commandSpy = mock(async () => {});
    const hooks = await plugin.server({
      client: { session: { command: commandSpy } },
    } as any);

    await hooks.config({ agent: null, command: null } as any);

    await hooks["chat.message"](
      { sessionID: "s1", agent: "primary" } as any,
      { message: {}, parts: [] } as any,
    );

    expect(commandSpy).toHaveBeenCalledTimes(0);
  });

  test("chat.message hook skips when agent is adversarial-review (prevents loop)", async () => {
    const commandSpy = mock(async () => {});
    const hooks = await plugin.server({
      client: { session: { command: commandSpy } },
    } as any);

    await hooks.config({
      experimental: { reviewGate: { enabled: true } },
      agent: {},
      command: {},
    } as any);

    await hooks["chat.message"](
      { sessionID: "s1", agent: "adversarial-review" } as any,
      { message: {}, parts: [] } as any,
    );

    expect(commandSpy).toHaveBeenCalledTimes(0);
  });

  test("chat.message hook skips when no tool edits were detected", async () => {
    const commandSpy = mock(async () => {});
    const hooks = await plugin.server({
      client: { session: { command: commandSpy } },
    } as any);

    await hooks.config({
      experimental: { reviewGate: { enabled: true } },
      agent: {},
      command: {},
    } as any);

    await hooks["chat.message"](
      { sessionID: "s1", agent: "primary" } as any,
      { message: {}, parts: [] } as any,
    );

    expect(commandSpy).toHaveBeenCalledTimes(0);
  });

  test("tool.execute.after does not set pendingReview for non-edit tools", async () => {
    const commandSpy = mock(async () => {});
    const hooks = await plugin.server({
      client: { session: { command: commandSpy } },
    } as any);

    await hooks.config({
      experimental: { reviewGate: { enabled: true } },
      agent: {},
      command: {},
    } as any);

    await hooks["tool.execute.after"](
      { tool: "read", sessionID: "s1", callID: "c1", args: {} } as any,
      { title: "", output: "", metadata: {} } as any,
    );

    await hooks["chat.message"](
      { sessionID: "s1", agent: "primary" } as any,
      { message: {}, parts: [] } as any,
    );

    expect(commandSpy).toHaveBeenCalledTimes(0);
  });

  test("chat.message hook calls session.command when tool.execute.after detected edits and gate enabled", async () => {
    const commandSpy = mock(async () => {});
    const hooks = await plugin.server({
      client: { session: { command: commandSpy } },
    } as any);

    await hooks.config({
      experimental: { reviewGate: { enabled: true } },
      agent: {},
      command: {},
    } as any);

    await hooks["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "c1", args: {} } as any,
      { title: "", output: "", metadata: {} } as any,
    );

    await hooks["chat.message"](
      { sessionID: "s1", agent: "primary" } as any,
      { message: {}, parts: [] } as any,
    );

    expect(commandSpy).toHaveBeenCalledTimes(1);
    expect(commandSpy).toHaveBeenCalledWith({
      path: { id: "s1" },
      body: { command: "adversarial-review", arguments: "" },
    });
  });
});
