import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
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

  test("writes transformed system prompt capture when capture file is configured", async () => {
    const captureFile = `/tmp/opencode-agent-prompt-inheritance-${Date.now()}.jsonl`;
    process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE = captureFile;

    try {
      const hooks = await createHooks({ "inherit-base-prompt": "prepend" });
      const output = { system: ["Custom agent prompt"] };

      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
        output as never,
      );

      // Wait for fire-and-forget capture
      for (let i = 0; i < 10; i++) {
        const stats = await readFile(captureFile, "utf8")
          .then((s) => s.trim().split("\n"))
          .catch(() => []);
        if (stats.length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const contents = await readFile(captureFile, "utf8");
      const capture = JSON.parse(contents.trim()) as {
        agentName: string;
        inherited: boolean;
        mode: string;
        system: string[];
      };

      expect(capture.agentName).toBe("reviewer");
      expect(capture.mode).toBe("prepend");
      expect(capture.inherited).toBeTrue();
      expect(capture.system[0]).toContain("You are OpenCode, the best coding agent on the planet.");
      expect(capture.system[0]).toContain("Custom agent prompt");
    } finally {
      delete process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE;
      await rm(captureFile, { force: true });
    }
  });

  test("writes skipped capture when inheritance is disabled", async () => {
    const captureFile = `/tmp/opencode-agent-prompt-inheritance-disabled-${Date.now()}.jsonl`;
    process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE = captureFile;

    try {
      const hooks = await createHooks({ "inherit-base-prompt": false });
      const output = { system: ["Custom agent prompt"] };

      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
        output as never,
      );

      // Wait for fire-and-forget capture
      for (let i = 0; i < 10; i++) {
        const stats = await readFile(captureFile, "utf8")
          .then((s) => s.trim().split("\n"))
          .catch(() => []);
        if (stats.length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const contents = await readFile(captureFile, "utf8");
      const capture = JSON.parse(contents.trim()) as {
        inherited: boolean;
        mode: string | null;
        system: string[];
      };

      expect(capture.inherited).toBeFalse();
      expect(capture.mode).toBeNull();
      expect(capture.system).toEqual(["Custom agent prompt"]);
    } finally {
      delete process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE;
      await rm(captureFile, { force: true });
    }
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

  test("fails open if session.messages throws", async () => {
    const plugin = await loadPlugin();
    const ctx = createCtx({ "inherit-base-prompt": "prepend" });
    ctx.client.session.messages = async () => {
      throw new Error("Transient API error");
    };
    const hooks = await plugin.server(ctx as never);
    const output = { system: ["Custom agent prompt"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude" } } } as never,
      output as never,
    );
    expect(output.system).toEqual(["Custom agent prompt"]);
  });

  test("fails open if session.messages returns undefined data", async () => {
    const plugin = await loadPlugin();
    const ctx = createCtx({ "inherit-base-prompt": "prepend" });
    ctx.client.session.messages = async () => ({ data: undefined }) as never;
    const hooks = await plugin.server(ctx as never);
    const output = { system: ["Custom agent prompt"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude" } } } as never,
      output as never,
    );
    expect(output.system).toEqual(["Custom agent prompt"]);
  });

  test("uses the most recent agent when a session switches agents", async () => {
    const plugin = await loadPlugin();
    const ctx = createCtx({ "inherit-base-prompt": "prepend" });
    ctx.client.session.messages = async () => ({
      data: [
        { info: { agent: "old-agent" } },
        { info: { agent: "reviewer" } },
        { info: {} }, // Some agent-less message
      ] as never,
    });
    const hooks = await plugin.server(ctx as never);
    const output = { system: ["Custom agent prompt"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
      output as never,
    );
    expect(output.system[0]).toContain("You are OpenCode");
    expect(output.system[0]).toContain("Custom agent prompt");
  });

  test("fails open if capture file is unwritable", async () => {
    process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE =
      "/invalid/path/that/does/not/exist/capture.jsonl";
    try {
      const hooks = await createHooks({ "inherit-base-prompt": "prepend" });
      const output = { system: ["Custom agent prompt"] };

      await hooks["experimental.chat.system.transform"]?.(
        { sessionID: "session-1", model: { api: { id: "claude-sonnet-4-5" } } } as never,
        output as never,
      );

      // Verify that it still successfully transformed the prompt
      expect(output.system[0]).toContain("You are OpenCode");
      expect(output.system[0]).toContain("Custom agent prompt");
    } finally {
      delete process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE;
    }
  });

  test("selects prompts ignoring case (mixed-case models)", () => {
    expect(providerPromptForModel({ api: { id: "GPT-4.1" } })).toContain(
      "THE PROBLEM CAN NOT BE SOLVED WITHOUT EXTENSIVE INTERNET RESEARCH.",
    );
    expect(providerPromptForModel({ api: { id: "Claude-Sonnet-4-5" } })).toContain(
      "software engineering tasks",
    );
    expect(providerPromptForModel({ api: { id: "GEMINI-2.5-PRO" } })).toContain(
      "software engineering tasks",
    );
  });

  test("fails open if app.agents throws", async () => {
    const plugin = await loadPlugin();
    const ctx = createCtx({ "inherit-base-prompt": "prepend" });
    ctx.client.app.agents = async () => {
      throw new Error("Agent lookup failure");
    };
    const hooks = await plugin.server(ctx as never);
    const output = { system: ["Custom agent prompt"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude" } } } as never,
      output as never,
    );
    expect(output.system).toEqual(["Custom agent prompt"]);
  });

  test("appends multiple debug capture entries", async () => {
    const captureFile = `/tmp/opencode-agent-prompt-inheritance-multi-${Date.now()}.jsonl`;
    process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE = captureFile;

    try {
      const hooks = await createHooks({ "inherit-base-prompt": "prepend" });
      const output = { system: ["Custom prompt"] };

      const input = {
        sessionID: "session-1",
        model: { api: { id: "claude" } },
      } as never;

      await hooks["experimental.chat.system.transform"]?.(input, output as never);
      await hooks["experimental.chat.system.transform"]?.(input, output as never);

      // Wait a bit since capture is now fire-and-forget (Phase 3)
      for (let i = 0; i < 10; i++) {
        const stats = await readFile(captureFile, "utf8")
          .then((s) => s.trim().split("\n"))
          .catch(() => []);
        if (stats.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const contents = await readFile(captureFile, "utf8");
      const lines = contents.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).inherited).toBeTrue();
      expect(JSON.parse(lines[1]).inherited).toBeTrue();
    } finally {
      delete process.env.OPENCODE_AGENT_PROMPT_INHERITANCE_CAPTURE_FILE;
      await rm(captureFile, { force: true });
    }
  });

  test("distinguishes gpt vs codex in mixed-case", () => {
    const gpt = providerPromptForModel({ api: { id: "GPT-3.5-TURBO" } });
    const codex = providerPromptForModel({ api: { id: "GPT-CODEX-MIXED" } });

    expect(gpt).toContain("You are OpenCode, You and the user share the same workspace");
    expect(codex).toContain("## Editing constraints");
    expect(gpt).not.toBe(codex);
  });

  test("no-ops if sessionID is missing", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": "prepend" });
    const output = { system: ["Custom prompt"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "", model: { api: { id: "claude" } } } as never,
      output as never,
    );
    expect(output.system).toEqual(["Custom prompt"]);
  });

  test("no-ops if output.system is empty", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": "prepend" });
    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude" } } } as never,
      output as never,
    );
    expect(output.system).toEqual([]);
  });

  test("no-ops and warns if output.system[0] is not a string", async () => {
    const hooks = await createHooks({ "inherit-base-prompt": "prepend" });
    const output = { system: [{ type: "text", text: "Not a string" }] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "session-1", model: { api: { id: "claude" } } } as never,
      output as never,
    );
    expect(output.system[0]).toEqual({ type: "text", text: "Not a string" });
  });

  test("falls back to default prompt for unknown model ID", () => {
    const prompt = providerPromptForModel({ api: { id: "unknown-model-provider" } });
    expect(prompt).toContain("You are opencode, an interactive CLI tool");
  });
});
