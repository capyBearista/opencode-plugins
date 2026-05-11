import { describe, expect, test } from "bun:test";
import { providerPromptForModel } from "./provider-prompt.js";

async function loadPlugin() {
  return (await import("./index.ts")).default;
}

function createCtx(options: Record<string, unknown>, agents?: Record<string, unknown>[]) {
  const agentList =
    agents !== undefined
      ? agents
      : [
          {
            name: "reviewer",
            description: "Code reviewer",
            mode: "subagent",
            builtIn: false,
            permission: {
              edit: "ask",
              bash: {},
              webfetch: "ask",
              doom_loop: "ask",
              external_directory: "ask",
            },
            prompt: "When reviewing code, focus on correctness, risk, and missing tests.",
            tools: {},
            options,
          },
        ];

  return {
    directory: "/workspace/project",
    worktree: "/workspace/project",
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                id: "message-1",
                sessionID: "session-1",
                role: "user",
                time: { created: 1 },
                agent: "reviewer",
                model: {
                  providerID: "anthropic",
                  modelID: "claude-sonnet-4-5",
                },
              },
              parts: [],
            },
          ],
        }),
      },
      app: {
        agents: async () => ({ data: agentList }),
      },
    },
  };
}

async function createHooks(options: Record<string, unknown>, agents?: Record<string, unknown>[]) {
  const plugin = await loadPlugin();
  return plugin.server(createCtx(options, agents) as never);
}

describe("@capybearista/opencode-agent-prompt-inheritance", () => {
  test("has an id", async () => {
    const plugin = await loadPlugin();
    expect(plugin.id).toBeString();
    expect(plugin.id).toBe("capybearista.opencode-agent-prompt-inheritance");
  });

  test("exports a default object", async () => {
    const plugin = await loadPlugin();
    expect(plugin).toBeObject();
  });

  test("exports server hooks", async () => {
    const plugin = await loadPlugin();
    expect(plugin.server).toBeFunction();
  });

  test("prepends the provider prompt when requested", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": "prepend" });
    const output = { system: ["Custom agent prompt", "Keep me"] };

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
      output as never,
    );

    expect(output.system[0]).toContain("You are OpenCode, the best coding agent on the planet.");
    expect(output.system[0]).toContain("Custom agent prompt");
    expect(output.system[0].indexOf("You are OpenCode, the best coding agent on the planet.")).toBe(
      0,
    );
    expect(output.system[1]).toBe("Keep me");
  });

  test("keeps the custom prompt first when append is requested", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": "append" });
    const output = { system: ["Custom agent prompt", "Keep me"] };

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
      output as never,
    );

    expect(output.system[0]).toContain("Custom agent prompt");
    expect(output.system[0]).toContain("You are OpenCode, the best coding agent on the planet.");
    expect(output.system[0].indexOf("Custom agent prompt")).toBe(0);
    expect(output.system[1]).toBe("Keep me");
  });

  test("prefers kebab-case when both inheritance flags are present", async () => {
    const hooks = await createHooks({
      "inherit-base-prompt": "append",
      inheritBasePrompt: "prepend",
    });
    const output = { system: ["Custom agent prompt"] };

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
      output as never,
    );

    expect(output.system[0]).toContain("Custom agent prompt");
    expect(output.system[0]).toContain("You are OpenCode, the best coding agent on the planet.");
    expect(output.system[0].indexOf("Custom agent prompt")).toBe(0);
  });

  test("treats true as prepend", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": true });
    const output = { system: ["Custom agent prompt"] };

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
      output as never,
    );

    expect(output.system[0]).toContain("You are OpenCode, the best coding agent on the planet.");
    expect(output.system[0]).toContain("Custom agent prompt");
    expect(output.system[0].indexOf("You are OpenCode, the best coding agent on the planet.")).toBe(
      0,
    );
  });

  test("does nothing when inheritance is disabled", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": false });
    const output = { system: ["Custom agent prompt", "Keep me"] };

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
      output as never,
    );

    expect(output.system).toEqual(["Custom agent prompt", "Keep me"]);
  });

  test("does nothing when the agent cannot be resolved", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": "prepend" }, []);
    const output = { system: ["Custom agent prompt"] };

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
      output as never,
    );

    expect(output.system).toEqual(["Custom agent prompt"]);
  });

  test("selects codex prompt for codex models", () => {
    const prompt = providerPromptForModel({ api: { id: "gpt-codex" } });
    expect(prompt).toContain("## Editing constraints");
  });

  test("selects gpt prompt for non-codex gpt models", () => {
    const prompt = providerPromptForModel({ api: { id: "gpt-3.5-turbo" } });
    expect(prompt).toContain("You are OpenCode, You and the user share the same workspace");
  });

  test("selects beast prompt for gpt-4 and o-series families", () => {
    expect(providerPromptForModel({ api: { id: "gpt-4.1" } })).toContain(
      "THE PROBLEM CAN NOT BE SOLVED WITHOUT EXTENSIVE INTERNET RESEARCH.",
    );
    expect(providerPromptForModel({ api: { id: "o1" } })).toContain(
      "THE PROBLEM CAN NOT BE SOLVED WITHOUT EXTENSIVE INTERNET RESEARCH.",
    );
    expect(providerPromptForModel({ api: { id: "o3" } })).toContain(
      "THE PROBLEM CAN NOT BE SOLVED WITHOUT EXTENSIVE INTERNET RESEARCH.",
    );
  });
});
