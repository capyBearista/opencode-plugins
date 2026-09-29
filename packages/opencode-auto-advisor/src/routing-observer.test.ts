import { describe, expect, test } from "bun:test";
import { defaultConfig, type RoutingMode } from "./config.js";
import type { ContextMessage } from "./context.js";
import { ADVISOR_TOOL_NAME, registerPlugin } from "./index.js";
import { createTestContext } from "./index.test.js";
import type { AdvisorRouter, RouterAssessment, RoutingState } from "./routing-types.js";

const MESSAGES: readonly ContextMessage[] = [
  { id: "msg-user-1", time: { created: 1 }, type: "user", text: "Fix the bug" },
  {
    id: "msg-assistant-1",
    time: { created: 2, completed: 3 },
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    content: [{ type: "text", text: "on it" }],
  },
];

function wiring(options: {
  readonly mode: RoutingMode;
  readonly answers?: readonly (RouterAssessment | Error)[];
}) {
  const base = createTestContext();
  const prompts: Array<{ prompt: string; model?: unknown }> = [];
  const contextReads: string[] = [];
  const evaluated: RoutingState[] = [];
  const answers = options.answers ?? [{ advisorWouldHelp: 0.9, consequence: 4 }];
  const router: AdvisorRouter = {
    evaluate: async (state) => {
      evaluated.push(state);
      const answer = answers[Math.min(evaluated.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("scripted router has no answers");
      return answer;
    },
  };
  const ctx = {
    ...base.ctx,
    session: {
      ...base.ctx.session,
      context: async (input: { readonly sessionID: string }) => {
        contextReads.push(input.sessionID);
        return MESSAGES;
      },
    },
    generate: {
      text: async (input: { prompt: string; model?: unknown }) => {
        prompts.push(input);
        return { text: "advisor advice" };
      },
    },
  };
  const baseConfig = defaultConfig();
  let configLoads = 0;
  const loadConfig = async () => {
    configLoads += 1;
    return {
      ...baseConfig,
      routing: { ...baseConfig.routing, mode: options.mode },
    };
  };
  return {
    ...base,
    ctx,
    prompts,
    contextReads,
    evaluated,
    router,
    loadConfig,
    configLoads: () => configLoads,
  };
}

function dispatch(extra: Record<string, unknown> = {}) {
  return Object.freeze({
    sessionID: "ses_1",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [],
    messages: [],
    options: {},
    tools: {},
    ...extra,
  });
}

function fireHook(context: ReturnType<typeof createTestContext>, input: Record<string, unknown>) {
  const callback = context.hookCallbacks.get("context");
  expect(callback).toBeFunction();
  return callback?.(input);
}

describe("routing observer wiring", () => {
  test("registers exactly one context hook and disposes it with the tool", async () => {
    const context = wiring({ mode: "off" });
    const cleanup = await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });

    expect(context.hooks).toEqual(["context"]);
    expect(context.hookCallbacks.get("context")).toBeFunction();

    await cleanup?.();
    await cleanup?.();
    expect(context.disposers).toEqual(["hook:context", `tool:${ADVISOR_TOOL_NAME}`]);
  });

  test("off mode performs zero evaluations and zero session reads", async () => {
    const context = wiring({ mode: "off" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });
    const before = JSON.stringify(value);

    await fireHook(context, value);

    expect(context.contextReads).toHaveLength(0);
    expect(context.evaluated).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
    expect(JSON.stringify(value)).toBe(before);
  });

  test("observe mode evaluates primary dispatches without generating", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });
    const before = JSON.stringify(value);

    await fireHook(context, value);

    expect(context.contextReads).toEqual(["ses_1"]);
    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(0);
    expect(JSON.stringify(value)).toBe(before);
  });

  test("skips unknown future kinds before invoking the domain", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });

    await fireHook(context, dispatch({ kind: "summary" }));

    expect(context.configLoads()).toBe(0);
    expect(context.contextReads).toHaveLength(0);
    expect(context.evaluated).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
  });

  test("evaluates a frozen dispatch with no kind property (live host shape)", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.hasOwn(value, "kind")).toBe(false);

    await fireHook(context, value);

    expect(context.configLoads()).toBe(1);
    expect(context.contextReads).toEqual(["ses_1"]);
    expect(context.evaluated).toHaveLength(1);
    expect(context.evaluated[0]?.sessionID).toBe("ses_1");
    expect(context.evaluated[0]?.entries.length).toBeGreaterThan(0);
    expect(context.prompts).toHaveLength(0);
  });

  for (const kind of ["compaction", "title", "generate"] as const) {
    test(`never routes ${kind} dispatches`, async () => {
      const context = wiring({ mode: "active" });
      await registerPlugin(context.ctx as never, {
        loadConfig: context.loadConfig,
        router: context.router,
      });

      await fireHook(context, dispatch({ kind }));

      expect(context.contextReads).toHaveLength(0);
      expect(context.evaluated).toHaveLength(0);
      expect(context.prompts).toHaveLength(0);
    });
  }

  test("active mode consults the advisor without mutating the dispatch", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });
    const before = JSON.stringify(value);

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(1);
    expect(JSON.stringify(value)).toBe(before);
  });

  test("suppresses a repeat dispatch with unchanged state", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });

    await fireHook(context, dispatch({ kind: "primary" }));
    await fireHook(context, dispatch({ kind: "primary" }));

    expect(context.evaluated).toHaveLength(1);
  });

  test("explicit advisor consultations do not consume the automatic budget", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];
    const toolContext = { sessionID: "ses_1", messageID: "msg-assistant-1" };

    await tool?.execute({}, toolContext);
    await tool?.execute({}, toolContext);
    expect(context.prompts).toHaveLength(2);

    await fireHook(context, dispatch({ kind: "primary" }));

    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(3);
  });
});
