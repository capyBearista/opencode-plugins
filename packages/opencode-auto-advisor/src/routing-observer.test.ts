import { describe, expect, test } from "bun:test";
import {
  ADVISOR_DELIVERY_PREFIX,
  type AdviceDeliveryInput,
  deliverAdvice,
  deliverRetainedReviews,
  type RetainedReviewDeliveryInput,
} from "./advice-delivery.js";
import { type AdviceHistory, createAdviceHistory } from "./advice-history.js";
import {
  ADVISOR_OMISSION_MARKER,
  type AdvisorProjectionBuilder,
  buildAdvisorProjection,
} from "./advisor-projection.js";
import { EXECUTOR_ADVISOR_GUIDANCE } from "./advisor-prompts.js";
import {
  type AdvisorConsultationInput,
  type AdvisorService,
  AdvisorTimeoutError,
  createAdvisorService,
} from "./advisor-service.js";
import { type AdvisorConfig, defaultConfig, type RoutingMode } from "./config.js";
import type { ContextMessage } from "./context.js";
import { ADVISOR_TOOL_NAME, registerPlugin } from "./index.js";
import { createTestContext } from "./index.test.js";
import type { ModelLimitResolver } from "./model-limits.js";
import { createOperationLifetime, type OperationLifetime } from "./operation-lifetime.js";
import type { PermissionRule } from "./permission-match.js";
import { createReviewLifecycle, type ReviewLifecycle } from "./review-lifecycle.js";
import { RouterError } from "./router.js";
import {
  ADVISOR_HISTORY_CAPACITY_SKIP_REASON,
  ADVISOR_HISTORY_UNAVAILABLE_SKIP_REASON,
  ADVISOR_LIMITS_SKIP_REASON,
} from "./routing.js";
import { registerRoutingObserver } from "./routing-observer.js";
import type { AdvisorRouter, RouterAssessment, RoutingState } from "./routing-types.js";
import { createSnapshotStore, type RequestSnapshot } from "./snapshot-store.js";
import type { TelemetryEventInput } from "./telemetry-types.js";

const PERSISTED_MESSAGES: readonly ContextMessage[] = [
  { id: "msg-user-1", time: { created: 1 }, type: "user", text: "persisted-only user message" },
  {
    id: "msg-assistant-1",
    time: { created: 2, completed: 3 },
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    content: [{ type: "text", text: "persisted-only assistant message" }],
  },
];

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

function wiring(options: {
  readonly mode: RoutingMode;
  readonly answers?: readonly (RouterAssessment | Error)[];
  readonly messages?: readonly ContextMessage[];
  readonly sessionGet?: (input: {
    readonly sessionID: string;
  }) => Promise<
    { readonly parentID?: string; readonly permissions?: readonly PermissionRule[] } | undefined
  >;
  readonly agentGet?: (input: {
    readonly agentID: string;
  }) => Promise<
    { readonly data?: { readonly permissions?: readonly PermissionRule[] } } | undefined
  >;
}) {
  const base = createTestContext();
  const prompts: Array<{ prompt: string; model?: unknown }> = [];
  const contextReads: string[] = [];
  const evaluated: RoutingState[] = [];
  const storage = memoryStorage();
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
      ...(options.sessionGet ? { get: options.sessionGet } : {}),
      context: async (input: { readonly sessionID: string }) => {
        contextReads.push(input.sessionID);
        return options.messages ?? PERSISTED_MESSAGES;
      },
    },
    ...(options.agentGet ? { agent: { get: options.agentGet } } : {}),
    storage,
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
    storage,
    loadConfig,
    configLoads: () => configLoads,
  };
}

function dispatch(extra: Record<string, unknown> = {}) {
  return Object.freeze({
    sessionID: "ses_1",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [{ type: "text", text: "hook-only system mutation" }],
    messages: [
      {
        id: "msg-user-1",
        role: "user",
        content: [{ type: "text", text: "hook-only user message" }],
      },
    ],
    options: {},
    tools: { [ADVISOR_TOOL_NAME]: { description: "advisor", input: { type: "object" } } },
    ...extra,
  });
}

function fireHook(context: ReturnType<typeof createTestContext>, input: unknown) {
  const callback = context.hookCallbacks.get("context");
  expect(callback).toBeFunction();
  return callback?.(input);
}

describe("routing observer wiring", () => {
  test("registers the context and compaction hooks and disposes them with the tool", async () => {
    const context = wiring({ mode: "off" });
    const cleanup = await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });

    expect(context.hooks).toEqual(["context", "compaction"]);
    expect(context.hookCallbacks.get("context")).toBeFunction();
    expect(context.hookCallbacks.get("compaction")).toBeFunction();

    await cleanup?.();
    await cleanup?.();
    expect(context.disposers).toEqual([
      "hook:context",
      "hook:compaction",
      `tool:${ADVISOR_TOOL_NAME}`,
    ]);
  });

  test("off mode performs zero evaluations and zero session reads while exposing guidance", async () => {
    const context = wiring({ mode: "off" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.contextReads).toHaveLength(0);
    expect(context.evaluated).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text === EXECUTOR_ADVISOR_GUIDANCE)).toHaveLength(1);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("off mode still captures the request snapshot for explicit consults", async () => {
    const context = createTestContext();
    const captured: RequestSnapshot[] = [];
    const router: AdvisorRouter = {
      evaluate: async () => {
        throw new Error("off mode must not evaluate");
      },
    };
    await registerRoutingObserver(context.ctx as never, {
      loadConfig: async () => defaultConfig(),
      router,
      service: { consult: async () => ({ advice: "unused" }) },
      snapshots: {
        capture: (snapshot) => {
          captured.push(snapshot);
        },
        read: () => undefined,
        sessions: () => captured.length,
      },
      resolveLimits: async () => ({ context: 200_000, output: 32_000 }),
    });

    await fireHook(context, dispatch({ kind: "primary" }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.sessionID).toBe("ses_1");
    expect(captured[0]?.turnKey).toBe("msg-user-1");
    expect(JSON.stringify(captured[0]?.entries)).toContain("hook-only system mutation");
  });

  test("observe mode evaluates primary dispatches without generating or reading history", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.contextReads).toHaveLength(0);
    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(0);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text === EXECUTOR_ADVISOR_GUIDANCE)).toHaveLength(1);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("routes the assembled hook-event request instead of persisted history", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });

    await fireHook(context, dispatch({ kind: "primary" }));

    const serialized = JSON.stringify(context.evaluated[0]?.entries);
    expect(serialized).toContain("hook-only system mutation");
    expect(serialized).toContain("hook-only user message");
    expect(serialized).not.toContain("persisted-only user message");
    expect(context.contextReads).toHaveLength(0);
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
    expect(context.contextReads).toHaveLength(0);
    expect(context.evaluated).toHaveLength(1);
    expect(context.evaluated[0]?.sessionID).toBe("ses_1");
    expect(context.evaluated[0]?.entries.length).toBeGreaterThan(0);
    expect(context.prompts).toHaveLength(0);
  });

  test("fail-open when the dispatch cannot be serialized", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });

    await fireHook(context, dispatch({ messages: null }));

    expect(context.evaluated).toHaveLength(0);
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

  test("active mode injects accepted advice into the dispatch system context", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(1);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system).toHaveLength(3);
    expect(system.at(-1)?.text).toContain(ADVISOR_DELIVERY_PREFIX);
    expect(system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toHaveLength(1);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
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

  test("explicit advisor consultations merge the hook snapshot with the current delta", async () => {
    const context = wiring({ mode: "off" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];

    await fireHook(context, dispatch({ kind: "primary" }));
    const result = await tool?.execute(
      {},
      { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" },
    );

    const prompt = context.prompts[0]?.prompt ?? "";
    expect(result?.content).toBe("advisor advice");
    expect(prompt).toContain("hook-only system mutation");
    expect(prompt).toContain("persisted-only assistant message");
    expect(prompt).not.toContain("persisted-only user message");
  });

  test("an id-less explicit consult merges the hook snapshot keyed by content identity", async () => {
    const context = wiring({
      mode: "off",
      messages: [
        { id: "", time: { created: 1 }, type: "user", text: "idless durable user" },
        {
          id: "msg-assistant-1",
          time: { created: 2, completed: 3 },
          type: "assistant",
          agent: "build",
          model: { providerID: "opencode", id: "jev-1.13" },
          content: [{ type: "text", text: "durable-only assistant delta" }],
        },
      ],
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];

    await fireHook(
      context,
      dispatch({
        system: [{ type: "text", text: "hook-only system mutation" }],
        messages: [{ role: "user", content: [{ type: "text", text: "idless durable user" }] }],
      }),
    );
    const result = await tool?.execute(
      {},
      { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" },
    );

    const prompt = context.prompts[0]?.prompt ?? "";
    expect(result?.content).toBe("advisor advice");
    expect(prompt).toContain("hook-only system mutation");
    expect(prompt).toContain("durable-only assistant delta");
  });

  test("a stale snapshot never attaches to a later consultation", async () => {
    const context = wiring({
      mode: "off",
      messages: [
        {
          id: "msg-user-2",
          time: { created: 10 },
          type: "user",
          text: "persisted-only user message",
        },
        {
          id: "msg-assistant-2",
          time: { created: 11, completed: 12 },
          type: "assistant",
          agent: "build",
          model: { providerID: "opencode", id: "jev-1.13" },
          content: [{ type: "text", text: "persisted-only assistant message" }],
        },
      ],
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];

    await fireHook(context, dispatch({ kind: "primary" }));
    await tool?.execute({}, { sessionID: "ses_1", messageID: "msg-assistant-2", agent: "build" });

    const prompt = context.prompts[0]?.prompt ?? "";
    expect(prompt).not.toContain("hook-only system mutation");
    expect(prompt).not.toContain("hook-only user message");
    expect(prompt).toContain("persisted-only user message");
  });

  test("explicit advisor consultations do not consume the automatic budget", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];
    const toolContext = { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" };

    await tool?.execute({}, toolContext);
    await tool?.execute({}, toolContext);
    expect(context.prompts).toHaveLength(2);

    await fireHook(context, dispatch({ kind: "primary" }));

    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(3);
  });

  test("explicit advisor consultations still run after the automatic budget is exhausted", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];
    const toolContext = { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" };

    await fireHook(context, dispatch({ kind: "primary" }));
    await fireHook(
      context,
      dispatch({
        kind: "primary",
        messages: [
          {
            id: "msg-user-1",
            role: "user",
            content: [{ type: "text", text: "hook-only user message" }],
          },
          { id: "msg-tool", role: "tool", content: [{ type: "text", text: "tool output" }] },
        ],
      }),
    );
    expect(context.evaluated).toHaveLength(1);

    await tool?.execute({}, toolContext);
    await tool?.execute({}, toolContext);

    expect(context.prompts).toHaveLength(3);
  });
});

describe("eligibility, guidance, and explicit review dedup", () => {
  test("injects the Executor guidance into an eligible primary dispatch exactly once", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text === EXECUTOR_ADVISOR_GUIDANCE)).toHaveLength(1);
    expect(context.evaluated).toHaveLength(1);
  });

  test("reuses owned guidance without duplication or fingerprint change", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);
    await fireHook(context, value);

    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text === EXECUTOR_ADVISOR_GUIDANCE)).toHaveLength(1);
    expect(context.evaluated).toHaveLength(1);
  });

  test("skips parented sessions before capture or routing", async () => {
    const context = wiring({
      mode: "observe",
      sessionGet: async () => ({ parentID: "ses_parent" }),
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(0);
    expect(context.configLoads()).toBe(0);
    expect((value as { system: unknown[] }).system).toHaveLength(1);
    expect(Object.hasOwn((value as { tools: object }).tools, ADVISOR_TOOL_NAME)).toBe(false);
  });

  test("skips sessions that do not advertise the advisor tool", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary", tools: {} });

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(0);
    expect((value as { system: unknown[] }).system).toHaveLength(1);
  });

  test("skips a session whose configured permissions deny the advisor", async () => {
    const context = wiring({
      mode: "observe",
      agentGet: async () => ({
        data: { permissions: [{ action: "advisor", resource: "*", effect: "deny" }] },
      }),
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(0);
    expect(context.configLoads()).toBe(0);
    expect(Object.hasOwn((value as { tools: object }).tools, ADVISOR_TOOL_NAME)).toBe(false);
  });

  test("skips the advertised-tool trap where a scoped allow follows a broad deny", async () => {
    const context = wiring({
      mode: "observe",
      agentGet: async () => ({
        data: {
          permissions: [
            { action: "advisor", resource: "*", effect: "deny" },
            { action: "advisor", resource: "src/*", effect: "allow" },
          ],
        },
      }),
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(0);
    expect(Object.hasOwn((value as { tools: object }).tools, ADVISOR_TOOL_NAME)).toBe(false);
  });

  test("fails open quietly when the session lookup fails and hides the unverifiable tool", async () => {
    const context = wiring({
      mode: "observe",
      sessionGet: async () => {
        throw new Error("session store down");
      },
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
    expect(Object.hasOwn((value as { tools: object }).tools, ADVISOR_TOOL_NAME)).toBe(false);
    expect((value as { system: unknown[] }).system).toHaveLength(1);
  });

  test("parented explicit consults fail before reading history or generating", async () => {
    const context = wiring({
      mode: "off",
      sessionGet: async () => ({ parentID: "ses_parent" }),
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];

    const result = await tool?.execute(
      {},
      { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" },
    );

    expect(result?.content).toContain("Auto Advisor consultation failed");
    expect(result?.content).toContain("parented");
    expect(context.contextReads).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
  });

  test("configured denial blocks explicit consults before reading history or generating", async () => {
    const context = wiring({
      mode: "off",
      agentGet: async () => ({
        data: { permissions: [{ action: "advisor", resource: "*", effect: "deny" }] },
      }),
    });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];

    const result = await tool?.execute(
      {},
      { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" },
    );

    expect(result?.content).toContain("Auto Advisor consultation failed");
    expect(context.contextReads).toHaveLength(0);
    expect(context.prompts).toHaveLength(0);
  });

  test("a successful explicit consult suppresses an equivalent automatic opportunity", async () => {
    const context = wiring({ mode: "observe" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];

    await fireHook(context, dispatch({ kind: "primary" }));
    expect(context.evaluated).toHaveLength(1);

    const result = await tool?.execute(
      {},
      { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" },
    );
    expect(result?.content).toBe("advisor advice");
    expect(context.prompts).toHaveLength(1);

    const equivalent = dispatch({
      kind: "primary",
      messages: [
        {
          id: "msg-user-1",
          role: "user",
          content: [{ type: "text", text: "hook-only user message" }],
        },
        {
          id: "msg-assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "persisted-only assistant message" }],
        },
      ],
    });
    await fireHook(context, equivalent);

    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(1);
  });

  test("a failed explicit consult does not suppress an equivalent automatic opportunity", async () => {
    const context = wiring({ mode: "observe" });
    const failing = {
      ...context.ctx,
      generate: {
        text: async () => {
          throw new Error("provider exploded");
        },
      },
    };
    await registerPlugin(failing as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const tool = context.added[0];

    await fireHook(context, dispatch({ kind: "primary" }));
    const result = await tool?.execute(
      {},
      { sessionID: "ses_1", messageID: "msg-assistant-1", agent: "build" },
    );
    expect(result?.content).toContain("provider exploded");

    const equivalent = dispatch({
      kind: "primary",
      messages: [
        {
          id: "msg-user-1",
          role: "user",
          content: [{ type: "text", text: "hook-only user message" }],
        },
        {
          id: "msg-assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "persisted-only assistant message" }],
        },
      ],
    });
    await fireHook(context, equivalent);

    expect(context.evaluated).toHaveLength(2);
  });
});

const ADVICE = "check the rollback path";

async function observerHarness(options: {
  readonly answers: readonly (RouterAssessment | Error)[];
  readonly mode?: RoutingMode;
  readonly deliver?: (input: AdviceDeliveryInput) => void;
  readonly deliverRetained?: (input: RetainedReviewDeliveryInput) => void;
  readonly service?: AdvisorService;
  readonly resolveLimits?: ModelLimitResolver;
  readonly project?: AdvisorProjectionBuilder;
  readonly loadConfig?: () => Promise<AdvisorConfig>;
  readonly telemetry?: { readonly record: (event: TelemetryEventInput) => Promise<void> };
  readonly history?: AdviceHistory;
  readonly omitHistory?: boolean;
  readonly lifecycle?: ReviewLifecycle;
  readonly absorbed?: (sessionID: never) => ReadonlySet<string>;
  readonly sessionGet?: (input: {
    readonly sessionID: string;
  }) => Promise<{ readonly parentID?: string } | undefined>;
  readonly router?: AdvisorRouter;
  readonly operations?: OperationLifetime;
}) {
  const context = createTestContext();
  const evaluated: RoutingState[] = [];
  const deliveries: AdviceDeliveryInput[] = [];
  const retainedDeliveries: RetainedReviewDeliveryInput[] = [];
  const events: TelemetryEventInput[] = [];
  const storage = memoryStorage();
  const history = options.history ?? createAdviceHistory(storage);
  const lifecycle = options.lifecycle ?? createReviewLifecycle();
  const snapshots = createSnapshotStore();
  const router: AdvisorRouter = options.router ?? {
    evaluate: async (state) => {
      evaluated.push(state);
      const answer = options.answers[Math.min(evaluated.length - 1, options.answers.length - 1)];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("scripted router has no answers");
      return answer;
    },
  };
  const consultations: AdvisorConsultationInput[] = [];
  const innerService: AdvisorService = options.service ?? {
    consult: async (input) => {
      input.onStart?.();
      return {
        advice: ADVICE,
        model: { providerID: "opencode", id: "jev-1.13" },
      };
    },
  };
  const service: AdvisorService = {
    consult: async (input) => {
      consultations.push(input);
      return innerService.consult(input);
    },
  };
  const baseConfig = defaultConfig();
  const registration = await registerRoutingObserver(
    {
      ...context.ctx,
      session: {
        ...context.ctx.session,
        ...(options.sessionGet ? { get: options.sessionGet } : {}),
      },
    } as never,
    {
      loadConfig:
        options.loadConfig ??
        (async () => ({
          ...baseConfig,
          routing: { ...baseConfig.routing, mode: options.mode ?? "active" },
        })),
      router,
      service,
      snapshots,
      resolveLimits: options.resolveLimits ?? (async () => ({ context: 200_000, output: 32_000 })),
      ...(options.project ? { project: options.project } : {}),
      telemetry: options.telemetry ?? {
        record: async (event) => {
          events.push(event);
        },
      },
      ...(options.omitHistory ? {} : { history }),
      lifecycle,
      ...(options.absorbed ? { absorbed: options.absorbed } : {}),
      ...(options.operations ? { operations: options.operations } : {}),
      deliver: (input) => {
        deliveries.push(input);
        if (options.deliver) options.deliver(input);
        else deliverAdvice(input);
      },
      deliverRetained: (input) => {
        retainedDeliveries.push(input);
        if (options.deliverRetained) options.deliverRetained(input);
        else deliverRetainedReviews(input);
      },
    },
  );
  return {
    context,
    registration,
    snapshots,
    consultations,
    evaluated,
    deliveries,
    retainedDeliveries,
    events,
    history,
    storage,
    lifecycle,
  };
}

function gatedHistory(inner: AdviceHistory) {
  let commitsThrow = false;
  let commitsMiss = false;
  const history: AdviceHistory = {
    ...inner,
    commit: async (grant, input) => {
      if (commitsThrow) throw new Error("storage write rejected");
      if (commitsMiss) return undefined;
      return inner.commit(grant, input);
    },
  };
  return {
    history,
    failCommits: () => {
      commitsThrow = true;
    },
    missCommits: () => {
      commitsMiss = true;
    },
  };
}

describe("automatic advice persistence acceptance", () => {
  test("a rejected persistence write fails open without delivering or publishing new advice", async () => {
    const gate = gatedHistory(createAdviceHistory(memoryStorage()));
    const harness = await observerHarness({
      answers: [
        { advisorWouldHelp: 0.9, consequence: 4 },
        { advisorWouldHelp: 0.9, consequence: 4 },
      ],
      history: gate.history,
    });

    await fireHook(harness.context, dispatch());
    expect(harness.lifecycle.status("ses_1").latest?.advice).toBe(ADVICE);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);

    gate.failCommits();
    const second = dispatch({
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "second turn" }] },
      ],
    });
    await fireHook(harness.context, second);

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.retainedDeliveries).toHaveLength(1);
    const system = (second as { system: Array<{ text?: string }> }).system;
    expect(system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toBe(false);
    expect(system.some((part) => part.text?.includes("[Auto Advisor retained reviews]"))).toBe(
      true,
    );
    const messages = (second as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(
      messages.some((message) => JSON.stringify(message.content).includes(ADVISOR_DELIVERY_PREFIX)),
    ).toBe(false);
    expect(
      messages.some((message) => JSON.stringify(message.content).includes("second turn")),
    ).toBe(true);
    const status = harness.lifecycle.status("ses_1");
    expect(status.running).toEqual([]);
    expect(status.lastFinished?.outcome).toBe("failed");
    expect(status.latest?.advice).toBe(ADVICE);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({
      mode: "active",
      decision: "fail",
      delivered: false,
      advisorOutcome: "failed",
      advisorInvocations: 1,
      errorClass: "PersistenceError",
      failureDisposition: "terminal",
    });
  });

  test("an undefined commit fails open and keeps the consumed inference quota", async () => {
    const gate = gatedHistory(createAdviceHistory(memoryStorage()));
    const harness = await observerHarness({
      answers: [
        { advisorWouldHelp: 0.9, consequence: 4 },
        { advisorWouldHelp: 0.9, consequence: 4 },
      ],
      history: gate.history,
    });

    await fireHook(harness.context, dispatch());
    gate.missCommits();

    const second = dispatch({
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "second turn" }] },
      ],
    });
    await fireHook(harness.context, second);

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({
      decision: "fail",
      delivered: false,
      advisorOutcome: "failed",
      advisorInvocations: 1,
    });
    expect(typeof harness.events.at(-1)?.advisorLatencyMs).toBe("number");
    const status = harness.lifecycle.status("ses_1");
    expect(status.running).toEqual([]);
    expect(status.lastFinished?.outcome).toBe("failed");
    expect(status.latest?.advice).toBe(ADVICE);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);

    const continuation = dispatch({
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "second turn" }] },
        { id: "msg-tool", role: "tool", content: [{ type: "text", text: "tool output" }] },
      ],
    });
    await fireHook(harness.context, continuation);

    expect(harness.evaluated).toHaveLength(2);
    expect(harness.events.at(-1)).toMatchObject({ decision: "deny", advisorInvocations: 0 });
  });

  test("a committed record precedes delivery and later-turn retention", async () => {
    const storage = memoryStorage();
    const history = createAdviceHistory(storage);
    const order: string[] = [];
    const ordered: AdviceHistory = {
      ...history,
      commit: async (grant, input) => {
        const record = await history.commit(grant, input);
        order.push(record === undefined ? "commit-miss" : "commit");
        return record;
      },
    };
    const harness = await observerHarness({
      answers: [
        { advisorWouldHelp: 0.9, consequence: 4 },
        { advisorWouldHelp: 0.1, consequence: 0 },
      ],
      history: ordered,
      deliver: (input) => {
        order.push("deliver");
        deliverAdvice(input);
      },
    });

    await fireHook(harness.context, dispatch());
    expect(order).toEqual(["commit", "deliver"]);
    expect((await harness.history.get("ses_1" as never))[0]?.advice).toBe(ADVICE);

    await fireHook(
      harness.context,
      dispatch({
        messages: [
          { id: "msg-user-2", role: "user", content: [{ type: "text", text: "next turn" }] },
        ],
      }),
    );

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.retainedDeliveries).toHaveLength(1);
    expect(harness.retainedDeliveries[0]?.records[0]?.advice).toBe(ADVICE);
  });
});

describe("operation lifetime guards", () => {
  test("forget during eligibility aborts before snapshots, Jev, or guidance", async () => {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      sessionGet: () => {
        markStarted();
        return new Promise((resolve) => {
          release = () => resolve({ parentID: undefined });
        });
      },
    });
    const value = dispatch();
    const pending = fireHook(harness.context, value);
    await started;

    harness.registration.forget("ses_1" as never);
    release();
    await pending;

    expect(harness.snapshots.sessions()).toBe(0);
    expect(harness.evaluated).toHaveLength(0);
    expect(harness.consultations).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.retainedDeliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(0);
    expect(harness.lifecycle.status("ses_1").running).toEqual([]);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text === EXECUTOR_ADVISOR_GUIDANCE)).toHaveLength(0);
  });

  test("forget during Jev evaluation prevents any Advisor start", async () => {
    let release: (assessment: RouterAssessment) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      router: {
        evaluate: async () => {
          markStarted();
          return new Promise<RouterAssessment>((resolve) => {
            release = resolve;
          });
        },
      },
    });
    const pending = fireHook(harness.context, dispatch());
    await started;

    harness.registration.forget("ses_1" as never);
    release({ advisorWouldHelp: 0.9, consequence: 4 });
    await pending;

    expect(harness.consultations).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(0);
    const status = harness.lifecycle.status("ses_1");
    expect(status.running).toEqual([]);
    expect(status.latest).toBeUndefined();
  });

  test("forget during the model-limit lookup prevents any Advisor start", async () => {
    let release: (limits: { readonly context: number; readonly output: number }) => void = () =>
      undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      resolveLimits: () => {
        markStarted();
        return new Promise<{ readonly context: number; readonly output: number }>((resolve) => {
          release = (limits) => resolve(limits);
        });
      },
    });
    const pending = fireHook(harness.context, dispatch());
    await started;

    harness.registration.forget("ses_1" as never);
    release({ context: 200_000, output: 32_000 });
    await pending;

    expect(harness.consultations).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(0);
    expect(harness.lifecycle.status("ses_1").running).toEqual([]);
  });

  test("forget during the retained read prevents delivery and telemetry", async () => {
    const inner = createAdviceHistory(memoryStorage());
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const history: AdviceHistory = {
      ...inner,
      get: (sessionID) =>
        new Promise<Awaited<ReturnType<AdviceHistory["get"]>>>((resolve) => {
          markStarted();
          release = () => {
            void inner.get(sessionID).then(resolve);
          };
        }),
    };
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      history,
    });
    const pending = fireHook(harness.context, dispatch());
    await started;

    harness.registration.forget("ses_1" as never);
    release();
    await pending;

    expect(harness.consultations).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.retainedDeliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(await inner.get("ses_1" as never)).toHaveLength(0);
  });

  test("forget during the reservation skips before Jev and releases the grant", async () => {
    const inner = createAdviceHistory(memoryStorage(), {
      limits: { maxAdviceChars: 1000, maxSessionChars: 1000 },
    });
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const history: AdviceHistory = {
      ...inner,
      reserve: (sessionID) =>
        new Promise<Awaited<ReturnType<AdviceHistory["reserve"]>>>((resolve) => {
          markStarted();
          release = () => {
            void inner.reserve(sessionID).then(resolve);
          };
        }),
    };
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      history,
    });
    const pending = fireHook(harness.context, dispatch());
    await started;

    harness.registration.forget("ses_1" as never);
    release();
    await pending;

    expect(harness.evaluated).toHaveLength(0);
    expect(harness.consultations).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(await inner.reserve("ses_1" as never)).toBeDefined();
  });

  test("forget during commit suppresses late publication", async () => {
    const inner = createAdviceHistory(memoryStorage());
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const history: AdviceHistory = {
      ...inner,
      commit: async (grant, input) => {
        markStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return inner.commit(grant, input);
      },
    };
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      history,
    });
    const pending = fireHook(harness.context, dispatch());
    await started;

    harness.registration.forget("ses_1" as never);
    release();
    await pending;

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.retainedDeliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(harness.lifecycle.status("ses_1").latest).toBeUndefined();
  });

  test("dispose during an in-flight generation publishes nothing late", async () => {
    const inner = createAdviceHistory(memoryStorage());
    let release: (value: { readonly text: string }) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const service = createAdvisorService({
      loadConfig: async () => defaultConfig(),
      generateText: () => {
        markStarted();
        return new Promise<{ readonly text: string }>((resolve) => {
          release = resolve;
        });
      },
    });
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      service,
      history: inner,
    });
    const pending = fireHook(harness.context, dispatch());
    await started;

    await harness.registration.dispose();
    release({ text: "late advice" });
    await pending;

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(await inner.get("ses_1" as never)).toHaveLength(0);
    expect(harness.lifecycle.status("ses_1").latest).toBeUndefined();
  });

  test("dispose during eligibility aborts before snapshots and Jev", async () => {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      sessionGet: () => {
        markStarted();
        return new Promise((resolve) => {
          release = () => resolve({ parentID: undefined });
        });
      },
    });
    const pending = fireHook(harness.context, dispatch());
    await started;

    await harness.registration.dispose();
    release();
    await pending;

    expect(harness.snapshots.sessions()).toBe(0);
    expect(harness.evaluated).toHaveLength(0);
    expect(harness.consultations).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
  });

  test("dispose leaves an externally shared lifetime running", async () => {
    const operations = createOperationLifetime();
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      operations,
    });
    const token = operations.begin("ses_1" as never);

    await harness.registration.dispose();

    expect(token.isCurrent()).toBe(true);
    token.release();
  });

  test("forget invalidates the shared operation lifetime", async () => {
    const operations = createOperationLifetime();
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      operations,
    });
    const token = operations.begin("ses_1" as never);

    harness.registration.forget("ses_1" as never);

    expect(token.isCurrent()).toBe(false);
  });

  test("a fresh operation after forget proceeds without tombstones", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      sessionGet: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve({ parentID: undefined });
        markStarted();
        return new Promise((resolve) => {
          release = () => resolve({ parentID: undefined });
        });
      },
    });
    const first = fireHook(harness.context, dispatch());
    await started;

    harness.registration.forget("ses_1" as never);
    release();
    await first;

    const value = dispatch();
    await fireHook(harness.context, value);

    expect(harness.evaluated).toHaveLength(1);
    expect(harness.consultations).toHaveLength(1);
    expect(harness.deliveries).toHaveLength(1);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toHaveLength(1);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });
});

describe("active delivery, telemetry, and retention", () => {
  test("injects accepted advice into the dispatch and persists it with telemetry", async () => {
    const harness = await observerHarness({
      answers: [
        {
          advisorWouldHelp: 0.9,
          consequence: 4,
          metadata: { model: "jev-1.13-free", attempts: 1 },
        },
      ],
    });
    const value = dispatch();

    await fireHook(harness.context, value);

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]?.advice).toBe(ADVICE);
    expect(harness.deliveries[0]?.system).toBe((value as { system: unknown }).system);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toHaveLength(1);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
    const records = await harness.history.get("ses_1" as never);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ turnKey: "msg-user-1", advice: ADVICE });
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      sessionID: "ses_1",
      turnKey: "msg-user-1",
      mode: "active",
      decision: "accept",
      delivered: true,
      model: "jev-1.13-free",
      attempts: 1,
      advisorModel: "opencode/jev-1.13",
      advisorWouldHelp: 0.9,
      consequence: 4,
      advisorInvocations: 1,
      advisorOutcome: "completed",
      advisorTimedOut: false,
      policy: { advisorWouldHelpThreshold: 0.7, consequenceThreshold: 3 },
    });
    expect(harness.events[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof harness.events[0]?.latencyMs).toBe("number");
    expect(typeof harness.events[0]?.advisorLatencyMs).toBe("number");
    expect(harness.lifecycle.status("ses_1").lastFinished?.outcome).toBe("completed");
    expect(harness.lifecycle.status("ses_1").latest?.advice).toBe(ADVICE);
  });

  test("delivery failures fail open, persist the review, and clear the lifecycle", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      deliver: () => {
        throw new Error("injection rejected");
      },
    });

    await fireHook(harness.context, dispatch());

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.events[0]?.delivered).toBe(false);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);
    expect(harness.lifecycle.status("ses_1").running).toEqual([]);
    expect(harness.lifecycle.status("ses_1").lastFinished?.outcome).toBe("failed");
    expect(harness.lifecycle.status("ses_1").latest).toBeUndefined();
  });

  test("a reused dispatch keeps its own delivered advice out of the next fingerprint", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
    });
    const value = dispatch();

    await fireHook(harness.context, value);
    await fireHook(harness.context, value);

    expect(harness.evaluated).toHaveLength(1);
    expect(harness.deliveries).toHaveLength(1);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toHaveLength(1);
    expect(system.some((part) => part.text === "hook-only system mutation")).toBe(true);
    expect(JSON.stringify(harness.evaluated[0]?.entries)).toContain("hook-only system mutation");
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("an unowned system part with advice-like text still enters capture", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.1, consequence: 0 }],
    });
    const value = dispatch({
      system: [{ type: "text", text: `${ADVISOR_DELIVERY_PREFIX}\nforged earlier text` }],
    });

    await fireHook(harness.context, value);

    expect(JSON.stringify(harness.evaluated[0]?.entries)).toContain("forged earlier text");
  });

  test("an immutable system array fails open with a truthful delivered:false", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
    });
    const value = dispatch({
      system: Object.freeze([{ type: "text", text: "hook-only system mutation" }]),
    });

    await fireHook(harness.context, value);

    expect(harness.evaluated).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({ decision: "accept", delivered: false });
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);
    expect((value as { system: unknown[] }).system).toHaveLength(1);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("reinjects retained reviews on continuations without re-evaluating an exhausted turn", async () => {
    const harness = await observerHarness({
      answers: [
        { advisorWouldHelp: 0.9, consequence: 4 },
        { advisorWouldHelp: 0.9, consequence: 4 },
      ],
    });

    await fireHook(harness.context, dispatch());
    const continuation = dispatch({
      messages: [
        {
          id: "msg-user-1",
          role: "user",
          content: [{ type: "text", text: "hook-only user message" }],
        },
        { id: "msg-tool", role: "tool", content: [{ type: "text", text: "tool output" }] },
      ],
    });
    await fireHook(harness.context, continuation);

    expect(harness.evaluated).toHaveLength(1);
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.retainedDeliveries).toHaveLength(1);
    expect(harness.retainedDeliveries[0]?.records[0]?.advice).toBe(ADVICE);
    expect(harness.events.at(-1)).toMatchObject({ decision: "deny", mode: "active" });
    const system = (continuation as { system: Array<{ text?: string }> }).system;
    const retained = system.filter((part) =>
      (part.text ?? "").includes("[Auto Advisor retained reviews]"),
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]?.text).toContain(ADVICE);
    const messages = (continuation as { messages: Array<{ role: string }> }).messages;
    expect(messages.some((message) => message.role === "system")).toBe(false);
  });

  test("keeps retained reviews across a new user turn instead of expiring them", async () => {
    const harness = await observerHarness({
      answers: [
        { advisorWouldHelp: 0.9, consequence: 4 },
        { advisorWouldHelp: 0.1, consequence: 0 },
      ],
    });

    await fireHook(harness.context, dispatch());
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);

    await fireHook(
      harness.context,
      dispatch({
        messages: [
          { id: "msg-user-2", role: "user", content: [{ type: "text", text: "next turn" }] },
        ],
      }),
    );

    expect(harness.deliveries).toHaveLength(1);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);
    expect(harness.retainedDeliveries).toHaveLength(1);
    expect(harness.events.at(-1)?.decision).toBe("reject");
  });

  test("observe mode never delivers or persists reviews", async () => {
    const harness = await observerHarness({
      mode: "observe",
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
    });

    await fireHook(harness.context, dispatch());

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.retainedDeliveries).toHaveLength(0);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(0);
    expect(harness.events[0]).toMatchObject({ mode: "observe", decision: "accept" });
    expect(harness.events[0]?.delivered).toBeUndefined();
    expect(harness.events[0]?.advisorInvocations).toBeUndefined();
  });

  test("router failures record the classified failure and never deliver", async () => {
    const failure = new RouterError("zen routing failed on jev-1.13-free (Authentication)", {
      errorClass: "Authentication",
      model: "jev-1.13-free",
      attempts: 1,
    });
    const harness = await observerHarness({ answers: [failure] });

    await fireHook(harness.context, dispatch());

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events[0]).toMatchObject({
      decision: "fail",
      errorClass: "Authentication",
      model: "jev-1.13-free",
      attempts: 1,
    });
  });

  test("records the failure disposition for a fail-open", async () => {
    const failure = new RouterError("zen routing failed on jev-1.13-free (Transport)", {
      errorClass: "Transport",
      model: "jev-1.13-free",
      attempts: 2,
      disposition: "retry",
    });
    const harness = await observerHarness({ answers: [failure] });

    await fireHook(harness.context, dispatch());

    expect(harness.events[0]).toMatchObject({
      decision: "fail",
      errorClass: "Transport",
      failureDisposition: "retry",
    });
  });

  test("records the raw and normalized consequence with probability metadata", async () => {
    const harness = await observerHarness({
      answers: [
        {
          advisorWouldHelp: 0.9,
          consequence: 3,
          metadata: {
            model: "jev-1.13-free",
            attempts: 1,
            rawConsequence: 2.6,
            consequenceProbabilities: { "0": 0.05, "1": 0.1, "2": 0.6, "3": 0.2, "4": 0.05 },
            consequenceConfidence: 0.9,
          },
        },
      ],
    });

    await fireHook(harness.context, dispatch());

    expect(harness.events[0]).toMatchObject({
      decision: "accept",
      consequence: 3,
      rawConsequence: 2.6,
      consequenceProbabilities: { "0": 0.05, "1": 0.1, "2": 0.6, "3": 0.2, "4": 0.05 },
      consequenceConfidence: 0.9,
    });
  });

  test("records the advisor context diagnostics on accept", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
    });

    await fireHook(harness.context, dispatch());

    expect(harness.events[0]).toMatchObject({
      decision: "accept",
      advisorContext: {
        complete: true,
        omittedEntries: 0,
        inputBudget: 150_000,
      },
    });
    expect(harness.events[0]?.advisorContext?.estimatedTokens).toBeLessThanOrEqual(150_000);
  });

  test("records incompleteness when a small-context advisor drops history", async () => {
    const transcripts: string[] = [];
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      resolveLimits: async () => ({ context: 2000, output: 1500 }),
      service: {
        consult: async (input) => {
          transcripts.push(input.transcript);
          return { advice: ADVICE };
        },
      },
    });
    const value = dispatch({
      messages: [
        {
          id: "msg-old",
          role: "user",
          content: [{ type: "text", text: `OLD-${"x".repeat(8000)}` }],
        },
        { id: "msg-user-1", role: "user", content: [{ type: "text", text: "CURRENT-TASK" }] },
      ],
    });

    await fireHook(harness.context, value);

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toContain("CURRENT-TASK");
    expect(transcripts[0]).not.toContain("OLD-");
    expect(transcripts[0]).toContain(ADVISOR_OMISSION_MARKER);
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      decision: "accept",
      delivered: true,
      advisorContext: { complete: false, omittedEntries: 1, inputBudget: 500 },
    });
  });

  test("records an advisor-limits skip without consulting or delivering", async () => {
    const calls: AdvisorConsultationInput[] = [];
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      resolveLimits: async () => undefined,
      service: {
        consult: async (input) => {
          calls.push(input);
          return { advice: ADVICE };
        },
      },
    });
    const value = dispatch();

    await fireHook(harness.context, value);

    expect(calls).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      mode: "active",
      decision: "skip",
      skipReason: ADVISOR_LIMITS_SKIP_REASON,
      advisorWouldHelp: 0.9,
      consequence: 4,
    });
    expect(harness.events[0]?.errorClass).toBeUndefined();
    expect(await harness.history.get("ses_1" as never)).toHaveLength(0);
    const messages = (value as { messages: Array<{ role: string }> }).messages;
    expect(messages).toHaveLength(1);
  });

  test("a provider length rejection fails open and the executor continues", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      service: {
        consult: async () => {
          throw new Error("prompt is too long: context length exceeded");
        },
      },
    });
    const value = dispatch();

    await fireHook(harness.context, value);

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events[0]).toMatchObject({ decision: "fail" });
    expect(harness.events[0]?.advisorContext?.complete).toBe(true);
    const messages = (value as { messages: Array<{ role: string }> }).messages;
    expect(messages).toHaveLength(1);
  });

  test("records consultation failures with a distinct class and terminal disposition", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      service: {
        consult: async () => {
          throw new Error("advisor generation failed");
        },
      },
    });

    await fireHook(harness.context, dispatch());

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events[0]).toMatchObject({
      decision: "fail",
      errorClass: "ConsultationError",
      failureDisposition: "terminal",
    });
    expect(harness.events[0]?.errorClass).not.toBe("RouterError");
  });

  test("never builds the advisor projection in observe mode", async () => {
    let projected = 0;
    const harness = await observerHarness({
      mode: "observe",
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      project: (state, options) => {
        projected += 1;
        return buildAdvisorProjection(state, options);
      },
    });

    await fireHook(harness.context, dispatch());

    expect(harness.events[0]?.decision).toBe("accept");
    expect(projected).toBe(0);
  });

  test("an unexpected domain throw fails open without delivery or telemetry", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      loadConfig: async () => ({ routing: null }) as never,
    });
    const value = dispatch();

    await fireHook(harness.context, value);

    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
    expect(harness.evaluated).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
  });

  test("a telemetry sink throw fails open after delivery", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      telemetry: {
        record: async () => {
          throw new Error("telemetry storage down");
        },
      },
    });
    const value = dispatch();

    await fireHook(harness.context, value);

    expect(harness.deliveries).toHaveLength(1);
    expect((await harness.history.get("ses_1" as never))[0]?.advice).toBe(ADVICE);
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toHaveLength(1);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });
});

describe("retention capacity and absorbed filtering", () => {
  test("excludes already-absorbed records from reinjection and advisor evidence", async () => {
    const absorbed = new Set<string>();
    const transcripts: string[] = [];
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      absorbed: () => absorbed,
      service: {
        consult: async (input) => {
          transcripts.push(input.transcript);
          return { advice: ADVICE };
        },
      },
    });
    const grant = await harness.history.reserve("ses_1" as never);
    if (!grant) throw new Error("reservation failed");
    const record = await harness.history.commit(grant, {
      turnKey: "turn-old",
      materialFingerprint: "f".repeat(64),
      advice: "absorbed advice",
    });
    if (!record) throw new Error("commit failed");
    absorbed.add(record.id);

    const value = dispatch();
    await fireHook(harness.context, value);

    expect(harness.retainedDeliveries).toHaveLength(0);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).not.toContain("absorbed advice");
    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toHaveLength(1);
    expect(
      system.some((part) => (part.text ?? "").includes("[Auto Advisor retained reviews]")),
    ).toBe(false);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("false capacity skips with the capacity reason and zero invocations", async () => {
    const history = createAdviceHistory(memoryStorage(), { limits: { maxRecordsPerSession: 1 } });
    const grant = await history.reserve("ses_1" as never);
    if (!grant) throw new Error("reservation failed");
    await history.commit(grant, {
      turnKey: "turn-old",
      materialFingerprint: "f".repeat(64),
      advice: "held review",
    });
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      history,
    });

    await fireHook(harness.context, dispatch());

    expect(harness.evaluated).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.retainedDeliveries).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      mode: "active",
      decision: "skip",
      skipReason: ADVISOR_HISTORY_CAPACITY_SKIP_REASON,
      advisorInvocations: 0,
    });
  });

  test("missing history skips automatic quietly with the unavailable reason", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      omitHistory: true,
    });
    const value = dispatch();

    await fireHook(harness.context, value);

    expect(harness.evaluated).toHaveLength(0);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.retainedDeliveries).toHaveLength(0);
    expect(harness.events[0]).toMatchObject({
      decision: "skip",
      skipReason: ADVISOR_HISTORY_UNAVAILABLE_SKIP_REASON,
    });
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("timeout finishes the lifecycle without publishing advice", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      service: {
        consult: async (input) => {
          input.onStart?.();
          throw new AdvisorTimeoutError(20);
        },
      },
    });

    await fireHook(harness.context, dispatch());

    expect(harness.events[0]).toMatchObject({
      decision: "fail",
      advisorOutcome: "timeout",
      advisorTimedOut: true,
      advisorInvocations: 1,
    });
    const status = harness.lifecycle.status("ses_1");
    expect(status.running).toEqual([]);
    expect(status.lastFinished?.outcome).toBe("timeout");
    expect(status.latest).toBeUndefined();
    expect(await harness.history.get("ses_1" as never)).toHaveLength(0);
  });

  test("failed and timed-out reviews keep the previous latest advice", async () => {
    let calls = 0;
    const harness = await observerHarness({
      answers: [
        { advisorWouldHelp: 0.9, consequence: 4 },
        { advisorWouldHelp: 0.9, consequence: 4 },
      ],
      service: {
        consult: async (input) => {
          input.onStart?.();
          calls += 1;
          if (calls === 1) return { advice: ADVICE };
          throw new AdvisorTimeoutError(20);
        },
      },
    });

    await fireHook(harness.context, dispatch());
    expect(harness.lifecycle.status("ses_1").latest?.advice).toBe(ADVICE);

    await fireHook(
      harness.context,
      dispatch({
        messages: [
          { id: "msg-user-2", role: "user", content: [{ type: "text", text: "next turn" }] },
        ],
      }),
    );

    const status = harness.lifecycle.status("ses_1");
    expect(status.lastFinished?.outcome).toBe("timeout");
    expect(status.latest?.advice).toBe(ADVICE);
    expect(await harness.history.get("ses_1" as never)).toHaveLength(1);
  });
});
