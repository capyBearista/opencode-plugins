import { Plugin } from "@opencode/plugin";
import {
  AdvisorTimeoutError,
  advisorPrompt,
  consult,
  type GenerateText,
  TOOL_DESCRIPTION,
  TOOL_NAME,
} from "./advisor.js";
import { createConfigLoader, type ModelRef } from "./config.js";
import { createRouter, type GenerateDecisions } from "./decisions.js";
import {
  ENTRY_KEY,
  hasReview,
  parseReview,
  pushTail,
  type Review,
  reviewText,
} from "./delivery.js";
import { decide } from "./policy.js";
import { AutoAdvisorRpc, type Status } from "./rpc.js";
import { createTelemetry, type TelemetryRecord } from "./telemetry.js";
import {
  advisorTranscript,
  decisionInput,
  type Message,
  type SystemText,
  turnKey,
} from "./transcript.js";

export const PLUGIN_ID = "capybearista.opencode-auto-advisor";

/** Fallback when the model catalog has no context limit for the Advisor's model. */
const DEFAULT_CONTEXT_TOKENS = 128_000;
/** Conservative chars-per-token, so the transcript fits even token-dense content. */
const CHARS_PER_TOKEN = 3;

interface Snapshot {
  readonly system: readonly SystemText[];
  readonly messages: readonly Message[];
  readonly tools: readonly string[];
  readonly model: ModelRef;
}

interface SessionState {
  child?: boolean;
  /** Last request seen in the `context` hook; the explicit tool reviews from it. */
  last?: Snapshot;
  /** Bumped when a run ends, so a consult that outlives its step never delivers. */
  epoch: number;
  turn?: string;
  step: number;
  started: number;
  /** Identity of the last evaluated state, so a retried step reuses its outcome. */
  memo?: { key: string; review: Promise<Review | undefined> };
  /** Ids of real user prompts, from the `prompt` hook. */
  prompts: Set<string>;
  observing: boolean;
  reviewing: boolean;
  failed: boolean;
}

const keyOf = (ref: ModelRef) => `${ref.providerID}/${ref.id}`;
const asText = (part: unknown) =>
  typeof (part as { text?: unknown })?.text === "string"
    ? { text: (part as { text: string }).text }
    : undefined;

/** Identity of a request's history, ignoring system updates (entries admitted on a retry). */
function stateKey(messages: readonly Message[]): string {
  const history = messages.filter((message) => message.role !== "system");
  const last = history.at(-1);
  const part = Array.isArray(last?.content)
    ? (last.content[0] as { id?: unknown } | undefined)
    : undefined;
  return `${history.length}:${last?.id ?? String(part?.id ?? "")}`;
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const loadConfig = createConfigLoader();
    const telemetry = createTelemetry();
    const sessions = new Map<string, SessionState>();
    const state = (sessionID: string) => {
      let found = sessions.get(sessionID);
      if (!found) {
        found = {
          epoch: 0,
          step: 0,
          started: 0,
          prompts: new Set(),
          observing: false,
          reviewing: false,
          failed: false,
        };
        sessions.set(sessionID, found);
      }
      return found;
    };

    const generateDecisions = ctx.experimental.generate.decisions as unknown as GenerateDecisions;
    const generateText = ctx.experimental.generate.text as unknown as GenerateText;
    const route = createRouter((request) => generateDecisions(request));

    const isChild = async (sessionID: string, session: SessionState) => {
      if (session.child === undefined) {
        const info = await ctx.session.get({ sessionID });
        session.child = Boolean(info.parentID);
      }
      return session.child;
    };

    const contextTokens = new Map<string, number>();
    const budgetChars = async (model: ModelRef) => {
      const key = keyOf(model);
      if (!contextTokens.has(key)) {
        let context = DEFAULT_CONTEXT_TOKENS;
        try {
          const { data } = await ctx.model.list({ types: ["chat"] });
          const info = data.find(
            (item) =>
              item.providerID === model.providerID && (item.modelID ?? item.id) === model.id,
          );
          if (info?.limit?.context) context = info.limit.context;
        } catch {}
        contextTokens.set(key, context);
      }
      const context = contextTokens.get(key) ?? DEFAULT_CONTEXT_TOKENS;
      return Math.floor(context * 0.75 * CHARS_PER_TOKEN);
    };

    const latestReview = async (sessionID: string) => {
      try {
        const entries = await ctx.session.instructions.entry.list({ sessionID });
        return parseReview(entries.find((entry) => entry.key === ENTRY_KEY)?.value) ?? null;
      } catch {
        return null;
      }
    };

    const status = async (sessionID: string): Promise<Status> => {
      const { config, error } = await loadConfig();
      const session = sessions.get(sessionID);
      return {
        sessionID,
        mode: config.routing.mode,
        configError: error ?? null,
        reviewing: session?.reviewing ?? false,
        failed: session?.failed ?? false,
        latest: await latestReview(sessionID),
      };
    };

    const rpc = await ctx.rpc.register(AutoAdvisorRpc, {
      status: async (input) => status((input as { sessionID: string }).sessionID),
    });
    const emit = (name: "review.started" | "review.finished", sessionID: string) => {
      status(sessionID)
        .then((snapshot) =>
          name === "review.started"
            ? rpc.events.emit("review.started", { ...snapshot })
            : rpc.events.emit("review.finished", { ...snapshot }),
        )
        .catch(() => {});
    };

    /** One Advisor consult over a snapshot; the model defaults to the Executor's. */
    const review = async (
      snapshot: Snapshot,
      advisorModel: ModelRef | undefined,
      timeoutMs: number,
      moment?: Review["moment"],
      signal?: AbortSignal,
    ) => {
      const model = advisorModel ?? snapshot.model;
      const transcript = advisorTranscript({ ...snapshot, budgetChars: await budgetChars(model) });
      const advice = await consult({
        generate: generateText,
        prompt: advisorPrompt(transcript, moment),
        model,
        timeoutMs,
        signal,
      });
      return { advice, model };
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, tool) => {
          const session = state(tool.sessionID);
          try {
            if (await isChild(tool.sessionID, session)) {
              return { content: "The Advisor is only available in top-level sessions." };
            }
            const snapshot = session.last;
            if (!snapshot) return { content: "The Advisor has no conversation to review yet." };
            // The cached request predates this step; add the in-flight message holding this call.
            const stored = await ctx.session.context({ sessionID: tool.sessionID });
            const current = stored.find((message) => message.id === tool.messageID);
            const inflight: Message[] =
              current && "content" in current && Array.isArray(current.content)
                ? [{ role: "assistant", content: current.content.map(storedPart) }]
                : [];
            const { config } = await loadConfig();
            const { advice } = await review(
              { ...snapshot, messages: [...snapshot.messages, ...inflight] },
              config.advisor.model,
              config.advisor.timeoutMs,
              undefined,
              tool.signal,
            );
            return { content: advice };
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            return {
              content: `Advisor consultation failed: ${message}`,
              metadata: { error: message },
            };
          }
        },
      });
    });

    const promptHook = await ctx.session.hook("prompt", async (event) => {
      state(event.sessionID).prompts.add(event.messageID);
    });

    const contextHook = await ctx.session.hook("context", async (event) => {
      try {
        const session = state(event.sessionID);
        if (await isChild(event.sessionID, session)) {
          delete event.tools[TOOL_NAME];
          return;
        }
        const messages = event.messages as unknown as Message[];
        const system = event.system.map(asText).filter((part): part is SystemText => Boolean(part));
        session.last = { system, messages, tools: Object.keys(event.tools), model: event.model };

        const { config } = await loadConfig();
        const { mode } = config.routing;
        if (mode === "off") return;

        const key = stateKey(messages);
        if (session.memo?.key === key) {
          // A retried step: reuse its review, and add it only if the retry doesn't carry it yet.
          const prior = await session.memo.review;
          if (prior && !hasReview(system, messages, prior.id))
            pushTail(messages, reviewText(prior));
          return;
        }

        const turn = turnKey(messages, session.prompts) ?? "";
        if (session.turn !== turn) {
          session.turn = turn;
          session.step = 0;
          session.started = 0;
        }
        session.step++;
        const base = {
          ts: new Date().toISOString(),
          session: event.sessionID,
          turn,
          step: session.step,
        };

        if (mode === "observe") {
          if (session.observing) return;
          session.observing = true;
          const text = decisionInput(messages);
          void route(config.routing.models, text)
            .then((routed) => {
              const verdict = routed.ok
                ? decide({ answers: routed.result.answers, routing: config.routing })
                : undefined;
              telemetry.record({
                ...base,
                mode,
                ...summary(routed, verdict),
                delivered: false,
              });
            })
            .finally(() => {
              session.observing = false;
            });
          return;
        }

        if (session.started >= config.routing.maxConsultationsPerTurn) return;
        const epoch = session.epoch;
        let settle: (value: Review | undefined) => void = () => {};
        session.memo = { key, review: new Promise((resolve) => (settle = resolve)) };
        let delivered: Review | undefined;
        let record: TelemetryRecord | undefined;
        try {
          const routed = await route(config.routing.models, decisionInput(messages));
          const verdict = routed.ok
            ? decide({ answers: routed.result.answers, routing: config.routing })
            : undefined;
          record = { ...base, mode, ...summary(routed, verdict), delivered: false };
          if (!verdict?.consult) return;

          session.started++;
          session.reviewing = true;
          session.failed = false;
          emit("review.started", event.sessionID);
          const start = Date.now();
          const advisorModel = config.advisor.model ?? event.model;
          try {
            const { advice } = await review(
              session.last,
              config.advisor.model,
              config.advisor.timeoutMs,
              verdict.reading.moment,
            );
            if (session.epoch !== epoch) {
              record = {
                ...record,
                advisor: { model: keyOf(advisorModel), ms: Date.now() - start, outcome: "stale" },
              };
              return;
            }
            const result: Review = {
              id: crypto.randomUUID(),
              moment: verdict.reading.moment,
              advice,
            };
            const text = reviewText(result);
            pushTail(messages, text);
            delivered = result;
            record = {
              ...record,
              advisor: {
                model: keyOf(advisorModel),
                ms: Date.now() - start,
                outcome: "ok",
                chars: advice.length,
              },
              delivered: true,
            };
            // Best-effort: the current request already has the review.
            await ctx.session.instructions.entry
              .put({ sessionID: event.sessionID, key: ENTRY_KEY, value: text })
              .catch(() => {});
          } catch (cause) {
            const timeout = cause instanceof AdvisorTimeoutError;
            session.failed = true;
            record = {
              ...record,
              advisor: {
                model: keyOf(advisorModel),
                ms: Date.now() - start,
                outcome: timeout ? "timeout" : "error",
              },
            };
          } finally {
            session.reviewing = false;
            emit("review.finished", event.sessionID);
          }
        } finally {
          settle(delivered);
          if (record) telemetry.record(record);
        }
      } catch {
        // Automatic review is best-effort: never fail the Executor's request.
      }
    });

    const events = ctx.event.subscribe({
      types: [
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.deleted",
      ],
    });
    const iterator = events[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const event = next.value as { type: string; data?: { sessionID?: string } };
        const sessionID = event.data?.sessionID;
        if (!sessionID) continue;
        if (event.type === "session.deleted") {
          sessions.delete(sessionID);
          continue;
        }
        const session = sessions.get(sessionID);
        if (session) {
          session.epoch++;
          // The request reference can hold large attachments; drop it once the run ends.
          session.last = undefined;
          session.memo = undefined;
        }
      }
    })().catch(() => {});

    return async () => {
      await iterator.return?.();
      await promptHook.dispose();
      await contextHook.dispose();
      await rpc.dispose();
      await telemetry.flush();
    };
  },
});

/** Stored session parts → request-shaped parts (text and tool calls are what the Advisor needs). */
function storedPart(part: unknown): Message["content"][number] & object {
  const value = part as {
    type?: string;
    text?: unknown;
    name?: unknown;
    state?: { input?: unknown };
  };
  if (value.type === "tool")
    return { type: "tool-call", name: value.name, input: value.state?.input };
  if (value.type === "text") return { type: "text", text: value.text };
  return { type: String(value.type) };
}

function summary(
  routed: Awaited<ReturnType<ReturnType<typeof createRouter>>>,
  verdict: ReturnType<typeof decide> | undefined,
): Pick<TelemetryRecord, "attempts" | "model" | "cost" | "moment" | "consequence" | "verdict"> {
  if (!routed.ok) return { attempts: routed.attempts, verdict: "no-decision" };
  const moment = routed.result.answers.find((answer) => answer.name === "moment");
  return {
    attempts: routed.attempts,
    model: routed.model,
    cost: routed.result.cost,
    moment: Object.fromEntries(
      (moment?.probabilities ?? []).map((item) => [String(item.value), item.probability]),
    ),
    consequence: verdict?.reading?.consequence,
    verdict: verdict ? (verdict.consult ? "consult" : verdict.reason) : "no-decision",
  };
}
