import { describe, expect, test } from "bun:test";
import {
  ADVISOR_DELIVERY_PREFIX,
  type AdviceDeliveryInput,
  createAdviceLifetime,
  deliverAdvice,
} from "./advice-delivery.js";
import {
  ADVISOR_OMISSION_MARKER,
  type AdvisorProjectionBuilder,
  buildAdvisorProjection,
} from "./advisor-projection.js";
import type { AdvisorConsultationInput, AdvisorService } from "./advisor-service.js";
import { type AdvisorConfig, defaultConfig, type RoutingMode } from "./config.js";
import type { ContextMessage } from "./context.js";
import { ADVISOR_TOOL_NAME, registerPlugin } from "./index.js";
import { createTestContext } from "./index.test.js";
import type { ModelLimitResolver } from "./model-limits.js";
import { RouterError } from "./router.js";
import { ADVISOR_LIMITS_SKIP_REASON } from "./routing.js";
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

function wiring(options: {
  readonly mode: RoutingMode;
  readonly answers?: readonly (RouterAssessment | Error)[];
  readonly messages?: readonly ContextMessage[];
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
        return options.messages ?? PERSISTED_MESSAGES;
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
    system: [{ type: "text", text: "hook-only system mutation" }],
    messages: [
      {
        id: "msg-user-1",
        role: "user",
        content: [{ type: "text", text: "hook-only user message" }],
      },
    ],
    options: {},
    tools: {},
    ...extra,
  });
}

function fireHook(context: ReturnType<typeof createTestContext>, input: unknown) {
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
    const before = JSON.stringify(value);

    await fireHook(context, value);

    expect(context.contextReads).toHaveLength(0);
    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(0);
    expect(JSON.stringify(value)).toBe(before);
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

  test("active mode injects accepted advice into the dispatch as a system message", async () => {
    const context = wiring({ mode: "active" });
    await registerPlugin(context.ctx as never, {
      loadConfig: context.loadConfig,
      router: context.router,
    });
    const value = dispatch({ kind: "primary" });

    await fireHook(context, value);

    expect(context.evaluated).toHaveLength(1);
    expect(context.prompts).toHaveLength(1);
    const messages = (value as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("system");
    expect(JSON.stringify(messages[1]?.content)).toContain(ADVISOR_DELIVERY_PREFIX);
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
    const result = await tool?.execute({}, { sessionID: "ses_1", messageID: "msg-assistant-1" });

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
    const result = await tool?.execute({}, { sessionID: "ses_1", messageID: "msg-assistant-1" });

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
    await tool?.execute({}, { sessionID: "ses_1", messageID: "msg-assistant-2" });

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
    const toolContext = { sessionID: "ses_1", messageID: "msg-assistant-1" };

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
    const toolContext = { sessionID: "ses_1", messageID: "msg-assistant-1" };

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

const ADVICE = "check the rollback path";

async function observerHarness(options: {
  readonly answers: readonly (RouterAssessment | Error)[];
  readonly mode?: RoutingMode;
  readonly deliver?: (input: AdviceDeliveryInput) => void;
  readonly service?: AdvisorService;
  readonly resolveLimits?: ModelLimitResolver;
  readonly project?: AdvisorProjectionBuilder;
  readonly loadConfig?: () => Promise<AdvisorConfig>;
  readonly telemetry?: { readonly record: (event: TelemetryEventInput) => Promise<void> };
}) {
  const context = createTestContext();
  const evaluated: RoutingState[] = [];
  const deliveries: AdviceDeliveryInput[] = [];
  const events: TelemetryEventInput[] = [];
  const lifetime = createAdviceLifetime();
  const router: AdvisorRouter = {
    evaluate: async (state) => {
      evaluated.push(state);
      const answer = options.answers[Math.min(evaluated.length - 1, options.answers.length - 1)];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("scripted router has no answers");
      return answer;
    },
  };
  const baseConfig = defaultConfig();
  await registerRoutingObserver(context.ctx as never, {
    loadConfig:
      options.loadConfig ??
      (async () => ({
        ...baseConfig,
        routing: { ...baseConfig.routing, mode: options.mode ?? "active" },
      })),
    router,
    service: options.service ?? {
      consult: async () => ({
        advice: ADVICE,
        model: { providerID: "opencode", id: "jev-1.13" },
      }),
    },
    snapshots: createSnapshotStore(),
    resolveLimits: options.resolveLimits ?? (async () => ({ context: 200_000, output: 32_000 })),
    ...(options.project ? { project: options.project } : {}),
    telemetry: options.telemetry ?? {
      record: async (event) => {
        events.push(event);
      },
    },
    lifetime,
    deliver: (input) => {
      deliveries.push(input);
      if (options.deliver) options.deliver(input);
      else deliverAdvice(input);
    },
  });
  return { context, evaluated, deliveries, events, lifetime };
}

describe("active delivery, telemetry, and lifetime", () => {
  test("injects accepted advice into the dispatch with telemetry", async () => {
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
    expect(harness.deliveries[0]?.messages).toBe((value as { messages: unknown }).messages);
    const messages = (value as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("system");
    expect(JSON.stringify(messages[1]?.content)).toContain(ADVISOR_DELIVERY_PREFIX);
    expect(harness.lifetime.current("ses_1" as never)).toEqual({
      turnKey: "msg-user-1",
      text: ADVICE,
    });
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
      policy: { advisorWouldHelpThreshold: 0.7, consequenceThreshold: 3 },
    });
    expect(harness.events[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof harness.events[0]?.latencyMs).toBe("number");
  });

  test("delivery failures fail open and are recorded", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      deliver: () => {
        throw new Error("injection rejected");
      },
    });

    await fireHook(harness.context, dispatch());

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.events[0]?.delivered).toBe(false);
    expect(harness.lifetime.current("ses_1" as never)).toBeUndefined();
  });

  test("reinjects live advice on continuations without re-evaluating an exhausted turn", async () => {
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
    expect(harness.deliveries).toHaveLength(2);
    expect(harness.deliveries[1]?.advice).toBe(ADVICE);
    expect(harness.events.at(-1)).toMatchObject({ decision: "deny", mode: "active" });
    const messages = (continuation as { messages: Array<{ role: string }> }).messages;
    expect(messages.at(-1)?.role).toBe("system");
    expect(harness.lifetime.current("ses_1" as never)?.text).toBe(ADVICE);
  });

  test("a new user turn expires the previous live advice", async () => {
    const harness = await observerHarness({
      answers: [
        { advisorWouldHelp: 0.9, consequence: 4 },
        { advisorWouldHelp: 0.1, consequence: 0 },
      ],
    });

    await fireHook(harness.context, dispatch());
    expect(harness.lifetime.current("ses_1" as never)?.turnKey).toBe("msg-user-1");

    await fireHook(
      harness.context,
      dispatch({
        messages: [
          { id: "msg-user-2", role: "user", content: [{ type: "text", text: "next turn" }] },
        ],
      }),
    );

    expect(harness.deliveries).toHaveLength(1);
    expect(harness.lifetime.current("ses_1" as never)).toBeUndefined();
    expect(harness.events.at(-1)?.decision).toBe("reject");
  });

  test("observe mode never delivers or records live advice", async () => {
    const harness = await observerHarness({
      mode: "observe",
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
    });

    await fireHook(harness.context, dispatch());

    expect(harness.deliveries).toHaveLength(0);
    expect(harness.lifetime.current("ses_1" as never)).toBeUndefined();
    expect(harness.events[0]).toMatchObject({ mode: "observe", decision: "accept" });
    expect(harness.events[0]?.delivered).toBeUndefined();
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
    expect(harness.lifetime.current("ses_1" as never)).toBeUndefined();
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

  test("an unexpected domain throw fails open and leaves the dispatch untouched", async () => {
    const harness = await observerHarness({
      answers: [{ advisorWouldHelp: 0.9, consequence: 4 }],
      loadConfig: async () => ({ routing: null }) as never,
    });
    const value = dispatch();
    const before = JSON.stringify(value);

    await fireHook(harness.context, value);

    expect(JSON.stringify(value)).toBe(before);
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
    expect(harness.lifetime.current("ses_1" as never)?.text).toBe(ADVICE);
    const messages = (value as { messages: Array<{ role: string }> }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("system");
  });
});
