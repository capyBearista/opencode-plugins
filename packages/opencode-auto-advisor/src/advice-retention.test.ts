import { describe, expect, test } from "bun:test";
import { ADVISOR_DELIVERY_PREFIX } from "./advice-delivery.js";
import type { AdviceRecord } from "./advice-history.js";
import { ADVICE_HISTORY_MAX_ADVICE_CHARS, ADVICE_HISTORY_STORAGE_KEY } from "./advice-history.js";
import { formatCompactionReviews } from "./advice-history-format.js";
import { EXECUTOR_ADVISOR_GUIDANCE } from "./advisor-prompts.js";
import { type AdvisorConfig, defaultConfig, type RoutingMode } from "./config.js";
import type { ContextMessage } from "./context.js";
import { ADVISOR_TOOL_NAME, registerPlugin } from "./index.js";
import { createTestContext } from "./index.test.js";
import { REVIEW_RPC_ID } from "./review-contract.js";
import { ADVISOR_LIMITS_SKIP_REASON, ADVISOR_PROJECTION_SKIP_REASON } from "./routing.js";
import type { AdvisorRouter, RouterAssessment } from "./routing-types.js";
import type { TelemetryEventInput } from "./telemetry-types.js";

const SESSION = "ses_1";

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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ticks = async (count = 3): Promise<void> => {
  for (let index = 0; index < count; index += 1) await tick();
};

function memoryStorage() {
  const values = new Map<string, unknown>();
  let holdWrites = false;
  let releaseWrite: (() => void) | undefined;
  let rejectHistoryWrites = false;
  return {
    values,
    hold: () => {
      holdWrites = true;
    },
    release: () => {
      holdWrites = false;
      releaseWrite?.();
      releaseWrite = undefined;
    },
    rejectHistoryWrites: () => {
      rejectHistoryWrites = true;
    },
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      if (holdWrites) await new Promise<void>((resolve) => (releaseWrite = resolve));
      if (rejectHistoryWrites && key === ADVICE_HISTORY_STORAGE_KEY) {
        throw new Error("storage write rejected");
      }
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
    scan: async () => ({ entries: [] }),
  };
}

async function storedRecords(
  storage: ReturnType<typeof memoryStorage>,
): Promise<readonly AdviceRecord[]> {
  const value = (await storage.get(ADVICE_HISTORY_STORAGE_KEY)) as
    | {
        readonly sessions: readonly {
          readonly sessionID: string;
          readonly records: readonly AdviceRecord[];
        }[];
      }
    | undefined;
  return value?.sessions.find((entry) => entry.sessionID === SESSION)?.records ?? [];
}

function eventStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const signals: AbortSignal[] = [];
  return {
    signals,
    push(payload: unknown) {
      queue.push(payload);
      wake?.();
      wake = undefined;
    },
    subscribe(options: { readonly signal?: AbortSignal }) {
      if (options.signal) signals.push(options.signal);
      return (async function* () {
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              options.signal?.addEventListener(
                "abort",
                () => {
                  closed = true;
                  resolve();
                },
                { once: true },
              );
            });
          }
          while (queue.length > 0) yield queue.shift();
        }
      })();
    },
  };
}

function fakeRpc() {
  const registrations = new Map<
    string,
    {
      readonly handlers: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;
      readonly emitted: Array<[string, unknown]>;
      disposed: number;
    }
  >();
  const rpc = {
    register: async (
      definition: { readonly id: string },
      handlers: Record<string, (input: unknown) => Promise<unknown>>,
    ) => {
      const registration = { handlers, emitted: [] as Array<[string, unknown]>, disposed: 0 };
      registrations.set(definition.id, registration);
      return {
        dispose: async () => {
          registration.disposed += 1;
        },
        events: {
          emit: async (...args: [string, unknown]) => {
            registration.emitted.push(args);
          },
        },
      };
    },
  };
  return {
    rpc,
    registrations,
    status: (sessionID: string) =>
      registrations.get(REVIEW_RPC_ID)?.handlers.status({ sessionID }) as Promise<{
        readonly running: readonly unknown[];
        readonly lastFinished?: { readonly outcome: string };
        readonly latest?: { readonly advice: string };
      }>,
  };
}

function heldGeneration() {
  const calls: Array<{ prompt: string; model?: unknown }> = [];
  let resolve: (value: { readonly text: string }) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((settle) => {
    markStarted = settle;
  });
  return {
    calls,
    started,
    text: (input: { prompt: string; model?: unknown }) => {
      calls.push(input);
      markStarted();
      return new Promise<{ readonly text: string }>((settle, fail) => {
        resolve = settle;
        reject = fail;
      });
    },
    resolve: (text: string) => resolve({ text }),
    reject,
  };
}

function dispatch(extra: Record<string, unknown> = {}) {
  return Object.freeze({
    sessionID: SESSION,
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

type CatalogEntry = {
  readonly id: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly limit: { readonly context: number; readonly output: number };
};

async function harness(
  options: {
    readonly mode?: RoutingMode;
    readonly answers?: readonly RouterAssessment[];
    readonly generate?: (input: {
      prompt: string;
      model?: unknown;
    }) => Promise<{ readonly text: string }>;
    readonly omitStorage?: boolean;
    readonly timeoutMs?: number;
    readonly catalog?: readonly CatalogEntry[];
    readonly sessionGet?: (input: {
      readonly sessionID: string;
    }) => Promise<{ readonly parentID?: string } | undefined>;
    readonly seedRecords?: number;
    readonly loadConfig?: () => Promise<AdvisorConfig>;
    readonly sessionContext?: () => Promise<readonly ContextMessage[]>;
    readonly modelList?: () => Promise<{ readonly data: readonly CatalogEntry[] }>;
  } = {},
) {
  const base = createTestContext();
  const storage = memoryStorage();
  const events = eventStream();
  const rpc = fakeRpc();
  const evaluated: unknown[] = [];
  const answers = options.answers ?? [{ advisorWouldHelp: 0.9, consequence: 4 }];
  const router: AdvisorRouter = {
    evaluate: async (state) => {
      evaluated.push(state);
      return (
        answers[Math.min(evaluated.length - 1, answers.length - 1)] ?? {
          advisorWouldHelp: 0.9,
          consequence: 4,
        }
      );
    },
  };
  const telemetry: TelemetryEventInput[] = [];
  const prompts: Array<{ prompt: string; model?: unknown }> = [];
  const generate =
    options.generate ??
    (async (input: { prompt: string; model?: unknown }) => {
      prompts.push(input);
      return { text: "advisor advice" };
    });
  if (options.seedRecords) {
    storage.values.set(ADVICE_HISTORY_STORAGE_KEY, {
      version: 1,
      nextSequence: options.seedRecords + 1,
      sessions: [
        {
          sessionID: SESSION,
          records: Array.from({ length: options.seedRecords }, (_, index) => ({
            id: `adv_seed_${index}`,
            sequence: index + 1,
            turnKey: "seed-turn",
            materialFingerprint: "f".repeat(64),
            advice: `seeded advice ${index}`,
          })),
        },
      ],
    });
  }
  const ctx = {
    ...base.ctx,
    session: {
      ...base.ctx.session,
      ...(options.sessionGet ? { get: options.sessionGet } : {}),
      context: options.sessionContext ?? (async () => PERSISTED_MESSAGES),
    },
    ...(options.omitStorage ? {} : { storage }),
    rpc: rpc.rpc,
    event: events,
    generate: { text: generate },
    model: {
      list:
        options.modelList ??
        (async () => ({
          data: options.catalog ?? [
            {
              id: "jev-1.13",
              providerID: "opencode",
              modelID: "jev-1.13",
              limit: { context: 200_000, output: 32_000 },
            },
          ],
        })),
    },
  };
  const cleanup = await registerPlugin(ctx as never, {
    loadConfig:
      options.loadConfig ??
      (async () => ({
        ...defaultConfig(),
        advisor: {
          ...defaultConfig().advisor,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
        routing: { ...defaultConfig().routing, mode: options.mode ?? "active" },
      })),
    router,
  });
  const fire = (name: string, input: unknown) => base.hookCallbacks.get(name)?.(input);
  return {
    base,
    ctx,
    cleanup,
    fire,
    evaluated,
    events,
    rpc,
    storage,
    telemetry,
    prompts,
    tool: base.added[0],
  };
}

function compactionEvent(extra: Record<string, unknown> = {}) {
  return {
    sessionID: SESSION,
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [] as Array<{ type: string; text: string }>,
    messages: [],
    options: {},
    ...extra,
  };
}

describe("retained review integration", () => {
  test("a held primary dispatch exposes a running review that finishes on reconnect query", async () => {
    const held = heldGeneration();
    const h = await harness({ generate: held.text });
    const value = dispatch();

    const pending = h.fire("context", value);
    await held.started;

    const running = await h.rpc.status(SESSION);
    expect(running.running).toHaveLength(1);
    expect(running.lastFinished).toBeUndefined();

    held.resolve("final advice");
    await pending;

    const finished = await h.rpc.status(SESSION);
    expect(finished.running).toEqual([]);
    expect(finished.lastFinished?.outcome).toBe("completed");
    expect(finished.latest?.advice).toBe("final advice");
    expect((await storedRecords(h.storage))[0]?.advice).toBe("final advice");
    expect(h.events.signals).toHaveLength(1);
    await h.cleanup();
  });

  test("a timed-out review clears lifecycle state and never stores or publishes late advice", async () => {
    const held = heldGeneration();
    const h = await harness({ generate: held.text, timeoutMs: 20 });
    const value = dispatch();

    await h.fire("context", value);

    const status = await h.rpc.status(SESSION);
    expect(status.running).toEqual([]);
    expect(status.lastFinished?.outcome).toBe("timeout");
    expect(status.latest).toBeUndefined();
    expect(await storedRecords(h.storage)).toHaveLength(0);
    const messages = (value as { messages: Array<{ role: string }> }).messages;
    expect(messages).toHaveLength(1);
    const event = [...h.storage.values.values()].find(
      (stored) => (stored as { decision?: string }).decision === "fail",
    ) as { advisorOutcome?: string; advisorTimedOut?: boolean } | undefined;
    expect(event?.advisorOutcome).toBe("timeout");
    expect(event?.advisorTimedOut).toBe(true);

    held.resolve("late advice");
    await ticks();
    const after = await h.rpc.status(SESSION);
    expect(after.latest).toBeUndefined();
    expect(await storedRecords(h.storage)).toHaveLength(0);
    await h.cleanup();
  });

  test("reinjects retained reviews once per context and never multiplies on a reused dispatch", async () => {
    const h = await harness();
    await h.fire("context", dispatch({ kind: "primary" }));
    expect(await storedRecords(h.storage)).toHaveLength(1);

    const reused = dispatch({
      kind: "primary",
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "second turn" }] },
      ],
    });
    await h.fire("context", reused);
    await h.fire("context", reused);

    const retained = reused.system.filter((part) =>
      part.text.includes("[Auto Advisor retained reviews]"),
    );
    expect(retained).toHaveLength(1);
    expect(h.evaluated).toHaveLength(2);

    const nextTurn = dispatch({
      kind: "primary",
      messages: [
        { id: "msg-user-3", role: "user", content: [{ type: "text", text: "third turn" }] },
      ],
    });
    await h.fire("context", nextTurn);
    const nextRetained = nextTurn.system.filter((part) =>
      part.text.includes("[Auto Advisor retained reviews]"),
    );
    expect(nextRetained).toHaveLength(1);
    await h.cleanup();
  });

  test("capacity exhaustion skips active before Jev while observe still classifies", async () => {
    const active = await harness({ seedRecords: 16 });
    await active.fire("context", dispatch({ kind: "primary" }));

    expect(active.evaluated).toHaveLength(0);
    const skipped = [...active.storage.values.values()].find(
      (stored) => (stored as { decision?: string }).decision === "skip",
    ) as { skipReason?: string; advisorInvocations?: number } | undefined;
    expect(skipped?.skipReason).toBe("advisor-history-capacity");
    expect(skipped?.advisorInvocations).toBe(0);
    await active.cleanup();

    const observe = await harness({ mode: "observe", seedRecords: 16 });
    await observe.fire("context", dispatch({ kind: "primary" }));
    expect(observe.evaluated).toHaveLength(1);
    await observe.cleanup();
  });

  test("missing storage skips automatic quietly while explicit stays usable", async () => {
    const h = await harness({ omitStorage: true });
    const value = dispatch({ kind: "primary" });

    await h.fire("context", value);

    expect(h.evaluated).toHaveLength(0);
    expect((value as { messages: unknown[] }).messages).toHaveLength(1);

    await h.fire("context", dispatch({ kind: "primary" }));
    const result = await h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    expect(result?.content).toBe("advisor advice");
    expect(h.prompts).toHaveLength(1);
    await h.cleanup();
  });

  test("compaction retention is shrink-safe and exact absorption retires the captured records", async () => {
    const h = await harness();
    await h.fire("context", dispatch({ kind: "primary" }));
    const records = await storedRecords(h.storage);
    expect(records).toHaveLength(1);

    const compaction = compactionEvent();
    await h.fire("compaction", compaction);
    expect(compaction.system).toHaveLength(1);
    expect(compaction.system[0]?.text).toContain("[AUTO_ADVISOR_RETAINED_REVIEWS_V1]");
    expect(compaction.system[0]?.text).not.toContain("advisor()");

    h.events.push({
      type: "session.compaction.ended",
      data: { sessionID: SESSION, text: formatCompactionReviews(records) },
    });
    await ticks();

    expect(await storedRecords(h.storage)).toHaveLength(0);

    const after = dispatch({
      kind: "primary",
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "after compaction" }] },
      ],
    });
    await h.fire("context", after);
    const retained = after.system.filter((part) =>
      part.text.includes("[Auto Advisor retained reviews]"),
    );
    expect(retained).toHaveLength(0);
    await h.cleanup();
  });

  test("paraphrased or failed compaction preserves retained records", async () => {
    const h = await harness();
    await h.fire("context", dispatch({ kind: "primary" }));
    const records = await storedRecords(h.storage);

    await h.fire("compaction", compactionEvent());
    h.events.push({
      type: "session.compaction.ended",
      data: { sessionID: SESSION, text: "the advisor suggested checking the migration" },
    });
    await ticks();
    expect(await storedRecords(h.storage)).toHaveLength(1);

    await h.fire("compaction", compactionEvent());
    h.events.push({
      type: "session.compaction.failed",
      data: { sessionID: SESSION, reason: "auto", error: { type: "x", message: "y" } },
    });
    await ticks();
    expect(await storedRecords(h.storage)).toHaveLength(1);
    expect(records).toHaveLength(1);
    await h.cleanup();
  });

  test("records committed after capture survive exact absorption", async () => {
    const h = await harness();
    await h.fire("context", dispatch({ kind: "primary" }));
    const captured = await storedRecords(h.storage);

    await h.fire("compaction", compactionEvent());

    const second = dispatch({
      kind: "primary",
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "second turn" }] },
      ],
    });
    await h.fire("context", second);
    expect(await storedRecords(h.storage)).toHaveLength(2);

    h.events.push({
      type: "session.compaction.ended",
      data: { sessionID: SESSION, text: formatCompactionReviews(captured) },
    });
    await ticks();

    const remaining = await storedRecords(h.storage);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.turnKey).toBe("msg-user-2");
    await h.cleanup();
  });

  test("session deletion clears state and a late explicit completion cannot recreate it", async () => {
    let calls = 0;
    let resolveHeld: (text: string) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((settle) => {
      markStarted = settle;
    });
    const h = await harness({
      generate: async () => {
        calls += 1;
        if (calls === 2) {
          markStarted();
          return new Promise<{ readonly text: string }>((resolve) => {
            resolveHeld = (text) => resolve({ text });
          });
        }
        return { text: calls === 1 ? "seed advice" : "later advice" };
      },
    });
    await h.fire("context", dispatch({ kind: "primary" }));
    expect(await storedRecords(h.storage)).toHaveLength(1);
    const evaluatedBefore = h.evaluated.length;

    await h.fire("context", dispatch({ kind: "primary" }));
    const explicit = h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    await started;

    h.events.push({ type: "session.deleted", data: { sessionID: SESSION } });
    await ticks();

    resolveHeld("late explicit advice");
    const result = await explicit;
    expect(result?.content).toContain("Auto Advisor consultation failed");
    expect(result?.content).toContain("invalidated");
    expect(await storedRecords(h.storage)).toHaveLength(0);
    const lateStatus = await h.rpc.status(SESSION);
    expect(lateStatus.latest).toBeUndefined();
    expect(lateStatus.running).toEqual([]);

    const after = dispatch({
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
    await h.fire("context", after);
    expect(h.evaluated.length).toBe(evaluatedBefore + 1);
    await h.cleanup();
  });

  test("a late automatic completion after deletion does not recreate history or lifecycle state", async () => {
    let resolveHeld: (text: string) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((settle) => {
      markStarted = settle;
    });
    const h = await harness({
      generate: async () => {
        markStarted();
        return new Promise<{ readonly text: string }>((resolve) => {
          resolveHeld = (text) => resolve({ text });
        });
      },
    });
    const pending = h.fire("context", dispatch());
    await started;

    h.events.push({ type: "session.deleted", data: { sessionID: SESSION } });
    await ticks();

    resolveHeld("late automatic advice");
    await pending;

    expect(await storedRecords(h.storage)).toHaveLength(0);
    const status = await h.rpc.status(SESSION);
    expect(status.latest).toBeUndefined();
    expect(status.running).toEqual([]);
    await h.cleanup();
  });

  test("tiny or missing projection skips without starting a lifecycle", async () => {
    const tiny = await harness({
      catalog: [
        {
          id: "jev-1.13",
          providerID: "opencode",
          modelID: "jev-1.13",
          limit: { context: 1000, output: 800 },
        },
      ],
    });
    await tiny.fire("context", dispatch({ kind: "primary" }));
    const tinyStatus = await tiny.rpc.status(SESSION);
    expect(tinyStatus.running).toEqual([]);
    expect(tinyStatus.lastFinished).toBeUndefined();
    const tinyEvent = [...tiny.storage.values.values()].find(
      (stored) => (stored as { decision?: string }).decision === "skip",
    ) as { skipReason?: string } | undefined;
    expect(tinyEvent?.skipReason).toBe(ADVISOR_PROJECTION_SKIP_REASON);
    await tiny.cleanup();

    const missing = await harness({ catalog: [] });
    await missing.fire("context", dispatch({ kind: "primary" }));
    const missingStatus = await missing.rpc.status(SESSION);
    expect(missingStatus.lastFinished).toBeUndefined();
    const missingEvent = [...missing.storage.values.values()].find(
      (stored) => (stored as { decision?: string }).decision === "skip",
    ) as { skipReason?: string } | undefined;
    expect(missingEvent?.skipReason).toBe(ADVISOR_LIMITS_SKIP_REASON);
    await missing.cleanup();
  });

  test("explicit projection includes retained evidence while markReviewed stays on raw state", async () => {
    const h = await harness();
    await h.fire("context", dispatch({ kind: "primary" }));
    const seeded = await storedRecords(h.storage);
    expect(seeded).toHaveLength(1);

    await h.fire("context", dispatch({ kind: "primary" }));
    const before = h.evaluated.length;

    const result = await h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    expect(result?.content).toBe("advisor advice");
    const explicitPrompt = h.prompts.at(-1)?.prompt ?? "";
    expect(explicitPrompt).toContain(seeded[0]?.advice ?? "");
    expect(explicitPrompt).toContain("hook-only user message");
    expect(await storedRecords(h.storage)).toHaveLength(1);

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
    await h.fire("context", equivalent);
    expect(h.evaluated.length).toBe(before);
    await h.cleanup();
  });

  test("explicit lookup failures return a clear error before history or generation", async () => {
    const h = await harness({
      sessionGet: async () => {
        throw new Error("session store down");
      },
    });

    const result = await h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );

    expect(result?.content).toContain("Auto Advisor consultation failed");
    expect(result?.content).toContain("session lookup failed");
    expect(h.prompts).toHaveLength(0);
    await h.cleanup();
  });

  test("uses the concrete executor model for projection limits and inference", async () => {
    const h = await harness();
    await h.fire("context", dispatch({ kind: "primary" }));

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.model).toEqual({ providerID: "opencode", id: "jev-1.13" });
    const event = [...h.storage.values.values()].find(
      (stored) => (stored as { decision?: string }).decision === "accept",
    ) as { advisorModel?: string } | undefined;
    expect(event?.advisorModel).toBe("opencode/jev-1.13");
    await h.cleanup();
  });

  test("owned guidance is excluded from capture and never enters the advisor transcript", async () => {
    const h = await harness();
    const value = dispatch({ kind: "primary" });

    await h.fire("context", value);

    const system = (value as { system: Array<{ text?: string }> }).system;
    expect(system.filter((part) => part.text === EXECUTOR_ADVISOR_GUIDANCE)).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.prompt).not.toContain(EXECUTOR_ADVISOR_GUIDANCE);
    await h.cleanup();
  });
});

describe("automatic advice persistence acceptance", () => {
  test("a rejected history write preserves the prior review and records a failed outcome", async () => {
    const h = await harness();
    await h.fire("context", dispatch({ kind: "primary" }));
    expect((await h.rpc.status(SESSION)).latest?.advice).toBe("advisor advice");
    expect(await storedRecords(h.storage)).toHaveLength(1);

    h.storage.rejectHistoryWrites();
    const second = dispatch({
      kind: "primary",
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "second turn" }] },
      ],
    });
    await h.fire("context", second);

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
      messages.some((message) =>
        JSON.stringify(message.content).includes("[Auto Advisor retained reviews]"),
      ),
    ).toBe(false);
    expect(
      messages.some((message) => JSON.stringify(message.content).includes("second turn")),
    ).toBe(true);

    const status = await h.rpc.status(SESSION);
    expect(status.running).toEqual([]);
    expect(status.lastFinished?.outcome).toBe("failed");
    expect(status.latest?.advice).toBe("advisor advice");
    const records = await storedRecords(h.storage);
    expect(records).toHaveLength(1);
    expect(records[0]?.advice).toBe("advisor advice");

    const event = [...h.storage.values.values()].find(
      (stored) => (stored as { decision?: string }).decision === "fail",
    ) as { delivered?: boolean; advisorOutcome?: string; advisorInvocations?: number } | undefined;
    expect(event).toMatchObject({
      delivered: false,
      advisorOutcome: "failed",
      advisorInvocations: 1,
    });
    await h.cleanup();
  });

  test("an oversize advice result is rejected without truncation and preserves the prior review", async () => {
    let calls = 0;
    const oversize = "x".repeat(ADVICE_HISTORY_MAX_ADVICE_CHARS + 1);
    const h = await harness({
      generate: async () => {
        calls += 1;
        return { text: calls === 1 ? "advisor advice" : oversize };
      },
    });
    await h.fire("context", dispatch({ kind: "primary" }));
    expect((await h.rpc.status(SESSION)).latest?.advice).toBe("advisor advice");

    const second = dispatch({
      kind: "primary",
      messages: [
        { id: "msg-user-2", role: "user", content: [{ type: "text", text: "second turn" }] },
      ],
    });
    await h.fire("context", second);

    const system = (second as { system: Array<{ text?: string }> }).system;
    expect(system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX))).toBe(false);
    const messages = (second as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(
      messages.some((message) => JSON.stringify(message.content).includes(ADVISOR_DELIVERY_PREFIX)),
    ).toBe(false);

    const status = await h.rpc.status(SESSION);
    expect(status.running).toEqual([]);
    expect(status.lastFinished?.outcome).toBe("failed");
    expect(status.latest?.advice).toBe("advisor advice");
    const records = await storedRecords(h.storage);
    expect(records).toHaveLength(1);
    expect(records[0]?.advice).toBe("advisor advice");
    expect(records[0]?.advice).not.toBe(oversize);

    const event = [...h.storage.values.values()].find(
      (stored) => (stored as { decision?: string }).decision === "fail",
    ) as { delivered?: boolean; advisorOutcome?: string; advisorInvocations?: number } | undefined;
    expect(event).toMatchObject({
      delivered: false,
      advisorOutcome: "failed",
      advisorInvocations: 1,
    });
    await h.cleanup();
  });
});

describe("plugin operation lifetime", () => {
  test("session deletion during eligibility prevents snapshots, Jev, and advice", async () => {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const h = await harness({
      sessionGet: () => {
        markStarted();
        return new Promise((resolve) => {
          release = () => resolve({ parentID: undefined });
        });
      },
    });
    const pending = h.fire("context", dispatch({ kind: "primary" }));
    await started;

    h.events.push({ type: "session.deleted", data: { sessionID: SESSION } });
    await ticks();
    release();
    await pending;

    expect(h.evaluated).toHaveLength(0);
    expect(await storedRecords(h.storage)).toHaveLength(0);
    expect((await h.rpc.status(SESSION)).latest).toBeUndefined();
    await h.cleanup();
  });

  test("plugin disposal during an in-flight generation publishes nothing late", async () => {
    const held = heldGeneration();
    const h = await harness({ generate: held.text });
    const pending = h.fire("context", dispatch({ kind: "primary" }));
    await held.started;

    await h.cleanup();
    held.resolve("late advice");
    await pending;

    expect(await storedRecords(h.storage)).toHaveLength(0);
    const status = await h.rpc.status(SESSION);
    expect(status.latest).toBeUndefined();
    expect(status.running).toEqual([]);
    const decisions = [...h.storage.values.values()].filter(
      (stored) => (stored as { decision?: string }).decision !== undefined,
    );
    expect(decisions).toHaveLength(0);
  });

  test("session deletion during explicit eligibility returns a clear error and no markReviewed", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const h = await harness({
      sessionGet: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve({ parentID: undefined });
        markStarted();
        return new Promise((resolve) => {
          release = () => resolve({ parentID: undefined });
        });
      },
    });
    const explicit = h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    await started;

    h.events.push({ type: "session.deleted", data: { sessionID: SESSION } });
    await ticks();
    release();
    const result = await explicit;

    expect(result?.content).toContain("Auto Advisor consultation failed");
    expect(result?.content).toContain("invalidated");
    expect(h.prompts).toHaveLength(0);

    const fresh = await h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    expect(fresh?.content).toBe("advisor advice");
    await h.cleanup();
  });

  test("session deletion during the explicit config load returns a clear error", async () => {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const h = await harness({
      loadConfig: () => {
        markStarted();
        return new Promise((resolve) => {
          release = () =>
            resolve({
              ...defaultConfig(),
              routing: { ...defaultConfig().routing, mode: "active" },
            });
        });
      },
    });
    const explicit = h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    await started;

    h.events.push({ type: "session.deleted", data: { sessionID: SESSION } });
    await ticks();
    release();
    const result = await explicit;

    expect(result?.content).toContain("invalidated");
    expect(h.prompts).toHaveLength(0);
    await h.cleanup();
  });

  test("session deletion during the explicit history read returns a clear error", async () => {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const h = await harness({
      sessionContext: () => {
        markStarted();
        return new Promise((resolve) => {
          release = () => resolve(PERSISTED_MESSAGES);
        });
      },
    });
    const explicit = h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    await started;

    h.events.push({ type: "session.deleted", data: { sessionID: SESSION } });
    await ticks();
    release();
    const result = await explicit;

    expect(result?.content).toContain("invalidated");
    expect(h.prompts).toHaveLength(0);
    await h.cleanup();
  });

  test("session deletion during the explicit model-limit lookup returns a clear error", async () => {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const h = await harness({
      modelList: () => {
        markStarted();
        return new Promise((resolve) => {
          release = () =>
            resolve({
              data: [
                {
                  id: "jev-1.13",
                  providerID: "opencode",
                  modelID: "jev-1.13",
                  limit: { context: 200_000, output: 32_000 },
                },
              ],
            });
        });
      },
    });
    const explicit = h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    await started;

    h.events.push({ type: "session.deleted", data: { sessionID: SESSION } });
    await ticks();
    release();
    const result = await explicit;

    expect(result?.content).toContain("invalidated");
    expect(h.prompts).toHaveLength(0);
    await h.cleanup();
  });

  test("plugin disposal during an in-flight explicit generation returns a clear error", async () => {
    const held = heldGeneration();
    const h = await harness({ generate: held.text });
    const explicit = h.tool?.execute(
      {},
      { sessionID: SESSION, messageID: "msg-assistant-1", agent: "build" },
    );
    await held.started;

    await h.cleanup();
    held.resolve("late explicit advice");
    const result = await explicit;

    expect(result?.content).toContain("Auto Advisor consultation failed");
    expect(result?.content).toContain("invalidated");
  });
});
