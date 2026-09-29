import { describe, expect, test } from "bun:test";
import { ConfigError } from "./config.js";
import type { ContextMessage, SessionID } from "./context.js";
import { registerPlugin } from "./index.js";
import { createTestContext } from "./index.test.js";

const ADVISOR_MESSAGE = {
  id: "msg-current",
  time: { created: 3 },
  type: "assistant",
  agent: "build",
  model: { providerID: "opencode", id: "jev-1.14" },
  content: [
    { type: "text", text: "I should double-check the migration." },
    {
      type: "tool",
      id: "call_1",
      name: "advisor",
      state: { status: "running", input: {}, metadata: {} },
      time: { created: 3 },
    },
  ],
} as ContextMessage;

const TOOL_CONTEXT = {
  sessionID: "ses_1" as SessionID,
  messageID: "msg-current",
};

function contextWith(messages: readonly ContextMessage[]) {
  const base = createTestContext();
  const prompts: Array<{ prompt: string; model?: unknown }> = [];
  const ctx = {
    ...base.ctx,
    session: {
      ...base.ctx.session,
      context: async () => messages,
    },
    generate: {
      text: async (input: { prompt: string; model?: unknown }) => {
        prompts.push(input);
        return { text: "Check the rollback path before migrating." };
      },
    },
  };
  return { ...base, ctx, prompts };
}

describe("advisor tool wiring", () => {
  test("returns advisor advice and inherits the in-flight executor model", async () => {
    const context = contextWith([ADVISOR_MESSAGE]);
    const cleanup = await registerPlugin(context.ctx as never, { loadConfig: configWithoutFile });

    const result = await context.added[0]?.execute({}, TOOL_CONTEXT);

    expect(result?.content).toBe("Check the rollback path before migrating.");
    expect(context.prompts).toHaveLength(1);
    expect(context.prompts[0]?.model).toEqual({ providerID: "opencode", id: "jev-1.14" });
    expect(context.prompts[0]?.prompt).toContain("I should double-check the migration.");
    await cleanup?.();
  });

  test("explicit config model wins over the in-flight executor model", async () => {
    const context = contextWith([ADVISOR_MESSAGE]);
    await registerPlugin(context.ctx as never, {
      loadConfig: async () => ({
        ...(await configWithoutFile()),
        advisor: { model: { providerID: "anthropic", id: "claude-sonnet-4" } },
      }),
    });

    const result = await context.added[0]?.execute({}, TOOL_CONTEXT);

    expect(context.prompts[0]?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4" });
    expect((result as { metadata?: { advisorModel?: string } }).metadata?.advisorModel).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  test("generation failures stay visible as the tool result", async () => {
    const context = contextWith([ADVISOR_MESSAGE]);
    const ctx = {
      ...context.ctx,
      generate: {
        text: async () => {
          throw new Error("provider exploded");
        },
      },
    };
    await registerPlugin(ctx as never, { loadConfig: configWithoutFile });

    const result = await context.added[0]?.execute({}, TOOL_CONTEXT);

    expect(result?.content).toContain("Auto Advisor consultation failed");
    expect(result?.content).toContain("provider exploded");
  });

  test("session read failures stay visible as the tool result", async () => {
    const context = contextWith([]);
    const ctx = {
      ...context.ctx,
      session: {
        ...context.ctx.session,
        context: async () => {
          throw new Error("session read failed");
        },
      },
    };
    await registerPlugin(ctx as never, { loadConfig: configWithoutFile });

    const result = await context.added[0]?.execute({}, TOOL_CONTEXT);

    expect(result?.content).toContain("session read failed");
  });

  test("configuration errors stay visible as the tool result", async () => {
    const context = contextWith([ADVISOR_MESSAGE]);
    await registerPlugin(context.ctx as never, {
      loadConfig: async () => {
        throw new ConfigError(
          "/tmp/auto-advisor.json",
          "routing.mode",
          "must be one of off, observe, active",
        );
      },
    });

    const result = await context.added[0]?.execute({}, TOOL_CONTEXT);

    expect(result?.content).toContain("routing.mode");
    expect(context.prompts).toHaveLength(0);
  });
});

async function configWithoutFile() {
  const { defaultConfig } = await import("./config.js");
  return defaultConfig();
}
