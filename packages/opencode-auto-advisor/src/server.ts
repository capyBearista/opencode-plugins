import { Plugin } from "@opencode/plugin";
import {
  AdvisorChainError,
  advisorPrompt,
  consult,
  type GenerateText,
  TOOL_DESCRIPTION,
  TOOL_NAME,
} from "./advisor.js";
import { type Config, createConfigLoader, type ModelRef, modelKey } from "./config.js";
import { createRouter, type GenerateDecisions } from "./decisions.js";
import {
  ENTRY_KEY,
  hasReview,
  parseReview,
  pushTail,
  type Review,
  reviewText,
} from "./delivery.js";
import { createWalker } from "./fallback.js";
import { decide } from "./policy.js";
import { AutoAdvisorRpc, type ReviewDetails, type Status } from "./rpc.js";
import { createTelemetry, LOGGED_INPUT_CHARS, type TelemetryRecord } from "./telemetry.js";
import {
  advisorTranscript,
  decisionInput,
  isRequest,
  type Message,
  type SystemText,
  truncateStart,
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
  /** The session's real prompt ids (a live set), to label the Advisor's transcript. */
  readonly prompts: ReadonlySet<string>;
}

interface SessionState {
  child?: boolean;
  /** Last request seen in the `context` hook; the explicit tool reviews from it. */
  last?: Snapshot;
  /** Bumped when a run ends, so a consult that outlives its step never delivers. */
  epoch: number;
  /**
   * Ids of real user prompts: from the `prompt` hook, plus those read once from the stored
   * history, which may predate this process.
   */
  prompts: Set<string>;
  hydrated: boolean;
  turn?: string;
  /** Steps this turn, for telemetry. */
  step: number;
  /** Distinct steps this session; retries don't count. */
  steps: number;
  /** `stateKey` of the last step seen, so a retry is not counted as a new step. */
  lastKey?: string;
  /** `steps` when the last automatic consult started, for the cooldown. */
  consultedAt?: number;
  /** Automatic consults started this turn. */
  started: number;
  /** Identity of the last evaluated state, so a retried step reuses its outcome. */
  memo?: { key: string; review: Promise<Review | undefined> };
  /** Aborted when the run ends, so a pending consult stops waiting at once. */
  abort?: AbortController;
  /** The latest delivered review's details; memory only, unlike the entry that holds its text. */
  latest?: { id: string; details: ReviewDetails };
  observing: boolean;
  reviewing: boolean;
  failed: boolean;
}

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
          prompts: new Set(),
          hydrated: false,
          step: 0,
          steps: 0,
          started: 0,
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

    /**
     * Synthetic notices, subagent results and shell notices reach the `context` hook as
     * `role: "user"` too; only the stored history keeps their `type`.
     */
    const realPrompts = async (sessionID: string, session: SessionState) => {
      if (!session.hydrated) {
        try {
          const stored = await ctx.session.context({ sessionID });
          for (const message of stored)
            if (message.type === "user") session.prompts.add(message.id);
          session.hydrated = true;
        } catch {
          // Retried on the next step.
        }
      }
      return session.prompts;
    };

    const contextTokens = new Map<string, number>();
    /** Characters for the Advisor's transcript: `maxTokens`, or 75% of its window if smaller. */
    const budgetChars = async (model: ModelRef, maxTokens: number) => {
      const key = modelKey(model);
      if (!contextTokens.has(key)) {
        try {
          const { data } = await ctx.model.list({ types: ["chat"] });
          const info = data.find(
            (item) =>
              item.providerID === model.providerID && (item.modelID ?? item.id) === model.id,
          );
          // Cache only a real answer: a failed lookup is retried on the next consult.
          contextTokens.set(key, info?.limit?.context || DEFAULT_CONTEXT_TOKENS);
        } catch {}
      }
      const context = contextTokens.get(key) ?? DEFAULT_CONTEXT_TOKENS;
      return Math.floor(Math.min(maxTokens, context * 0.75) * CHARS_PER_TOKEN);
    };

    const latestReview = async (sessionID: string) => {
      try {
        const entries = await ctx.session.instructions.entry.list({ sessionID });
        const review = parseReview(entries.find((entry) => entry.key === ENTRY_KEY)?.value);
        const known = sessions.get(sessionID)?.latest;
        return review
          ? { ...review, details: known?.id === review.id ? known.details : null }
          : null;
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
        sidebar: config.tui.sidebar,
        configError: error ?? null,
        reviewing: session?.reviewing ?? false,
        failed: session?.failed ?? false,
        latest: await latestReview(sessionID),
      };
    };

    const rpc = await ctx.rpc.register(AutoAdvisorRpc, {
      status: async (input) => status((input as { sessionID: string }).sessionID),
    });
    // Each event awaits a status lookup; chaining keeps `finished` from overtaking `started`.
    let emitting: Promise<unknown> = Promise.resolve();
    const emit = (name: "review.started" | "review.finished", sessionID: string) => {
      emitting = emitting
        .then(() => status(sessionID))
        .then((snapshot) =>
          name === "review.started"
            ? rpc.events.emit("review.started", { ...snapshot })
            : rpc.events.emit("review.finished", { ...snapshot }),
        )
        .catch(() => {});
    };

    const advisorChain = createWalker();
    /**
     * One Advisor consult over a snapshot, walking `advisor.models` until one answers. Each model
     * gets a transcript sized to its own window. With `timeoutMs` -1 only the host's HTTP
     * timeouts end a silent model, so one that is still reasoning is never cut off.
     */
    const review = async (
      snapshot: Snapshot,
      advisor: Config["advisor"],
      moment?: Review["moment"],
      signal?: AbortSignal,
    ) => {
      const walked = await advisorChain({
        entries: advisor.models.map((entry) => (entry === "inherit" ? snapshot.model : entry)),
        key: modelKey,
        attemptMs: Number.POSITIVE_INFINITY,
        totalMs: advisor.timeoutMs < 0 ? Number.POSITIVE_INFINITY : advisor.timeoutMs,
        call: async (model) => {
          const transcript = advisorTranscript({
            ...snapshot,
            budgetChars: await budgetChars(model, advisor.maxTokens),
            compact: advisor.compactContext,
          });
          return consult({
            generate: generateText,
            prompt: advisorPrompt(transcript, moment),
            model,
            signal,
          });
        },
      });
      if (!walked.ok) throw new AdvisorChainError(walked.attempts);
      return { advice: walked.value, model: walked.model, attempts: walked.attempts };
    };

    const toolRegistration = await ctx.tool.transform((editor) => {
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
            // With routing off, nothing has read the stored prompts yet.
            await realPrompts(tool.sessionID, session);
            // The cached request predates this step; add the in-flight message holding this call.
            const stored = await ctx.session.context({ sessionID: tool.sessionID });
            const current = stored.find((message) => message.id === tool.messageID);
            const inflight: Message[] =
              current && "content" in current && Array.isArray(current.content)
                ? [{ role: "assistant", content: current.content.map(storedPart) }]
                : [];
            const { config, error } = await loadConfig();
            // An invalid file falls back to defaults; consulting the Executor's model would hide that.
            if (error) throw new Error(`invalid config: ${error}`);
            const { advice } = await review(
              { ...snapshot, messages: [...snapshot.messages, ...inflight] },
              config.advisor,
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
      // Admitted, not yet delivered: it becomes the turn once it is in the request.
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
        const snapshot: Snapshot = {
          system,
          messages,
          tools: Object.keys(event.tools),
          model: event.model,
          prompts: session.prompts,
        };
        session.last = snapshot;

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
        // A retry of a step that was evaluated without a consult: nothing new to decide.
        if (session.lastKey === key) return;
        session.lastKey = key;

        const { routing } = config;
        const requests = {
          prompts: await realPrompts(event.sessionID, session),
          requests: routing.requests,
          requestMaxChars: routing.requestMaxChars,
        };
        // A compaction can drop the prompt from the window; the turn goes on until a new one.
        const turn =
          messages.findLast((message) => isRequest(message, requests.prompts))?.id ??
          session.turn ??
          "";
        const input = decisionInput(messages, requests);
        if (session.turn !== turn) {
          session.turn = turn;
          session.step = 0;
          session.started = 0;
        }
        session.step++;
        session.steps++;
        const base = {
          ts: new Date().toISOString(),
          session: event.sessionID,
          turn,
          step: session.step,
          message: messages.findLast((message) => message.id && message.role !== "system")?.id,
          input: truncateStart(input, LOGGED_INPUT_CHARS),
          inputChars: input.length,
        };

        const cooling =
          session.consultedAt !== undefined &&
          session.steps - session.consultedAt < routing.minStepsBetweenConsultations;
        // Cooldown first, so `budget` appears only once the cooldown has expired.
        const blocked =
          mode !== "active"
            ? undefined
            : cooling
              ? ("cooldown" as const)
              : session.started >= routing.maxConsultationsPerTurn
                ? ("budget" as const)
                : undefined;

        if (mode === "observe" || blocked) {
          // Decide without consulting, so telemetry still shows what the Decision model saw.
          if (session.observing) return;
          session.observing = true;
          void route(routing.models, input)
            .then((routed) => {
              const verdict = routed.ok
                ? decide({ answers: routed.value.answers, routing })
                : undefined;
              telemetry.record({
                ...base,
                mode,
                ...summary(routed, verdict),
                ...(blocked ? { blocked } : {}),
                ...(blocked && verdict?.consult ? { verdict: "blocked" } : {}),
                delivered: false,
              });
            })
            .catch(() => {})
            .finally(() => {
              session.observing = false;
            });
          return;
        }

        const epoch = session.epoch;
        const abort = new AbortController();
        session.abort = abort;
        let settle: (value: Review | undefined) => void = () => {};
        session.memo = { key, review: new Promise((resolve) => (settle = resolve)) };
        let delivered: Review | undefined;
        let record: TelemetryRecord | undefined;
        try {
          const routed = await route(routing.models, input);
          const verdict = routed.ok
            ? decide({ answers: routed.value.answers, routing })
            : undefined;
          record = { ...base, mode, ...summary(routed, verdict), delivered: false };
          // The run may have ended while the Decision model answered: don't pay for a consult.
          if (!verdict?.consult || session.epoch !== epoch) return;

          session.started++;
          session.consultedAt = session.steps;
          session.reviewing = true;
          session.failed = false;
          emit("review.started", event.sessionID);
          const start = Date.now();
          try {
            const consulted = await review(
              snapshot,
              config.advisor,
              verdict.reading.moment,
              abort.signal,
            );
            const advisor = { model: consulted.model, attempts: consulted.attempts };
            if (session.epoch !== epoch) {
              record = {
                ...record,
                advisor: { ...advisor, ms: Date.now() - start, outcome: "stale" },
              };
              return;
            }
            const result: Review = {
              id: crypto.randomUUID(),
              moment: verdict.reading.moment,
              advice: consulted.advice,
            };
            const text = reviewText(result);
            pushTail(messages, text);
            delivered = result;
            session.latest = {
              id: result.id,
              details: {
                at: new Date().toISOString(),
                model: consulted.model,
                ms: Date.now() - start,
              },
            };
            record = {
              ...record,
              advisor: {
                ...advisor,
                ms: Date.now() - start,
                outcome: "ok",
                chars: consulted.advice.length,
              },
              delivered: true,
            };
            // Best-effort: the current request already has the review.
            await ctx.session.instructions.entry
              .put({ sessionID: event.sessionID, key: ENTRY_KEY, value: text })
              .catch(() => {});
          } catch (cause) {
            const stale = session.epoch !== epoch;
            if (!stale) session.failed = true;
            const attempts = cause instanceof AdvisorChainError ? cause.attempts : [];
            const last = attempts.at(-1);
            record = {
              ...record,
              advisor: {
                model: last?.model ?? "unknown",
                attempts,
                ms: Date.now() - start,
                outcome: stale
                  ? "stale"
                  : attempts.some((attempt) => attempt.outcome === "timeout")
                    ? "timeout"
                    : "error",
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
          session.abort?.abort();
          // The request reference can hold large attachments; drop it once the run ends.
          session.last = undefined;
          session.memo = undefined;
        }
      }
    })().catch(() => {});

    return async () => {
      await iterator.return?.();
      await toolRegistration.dispose();
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
  const moment = routed.value.answers.find((answer) => answer.name === "moment");
  return {
    attempts: routed.attempts,
    model: routed.model,
    cost: routed.value.cost,
    moment: Object.fromEntries(
      (moment?.probabilities ?? []).map((item) => [String(item.value), item.probability]),
    ),
    consequence: verdict?.reading?.consequence,
    verdict: verdict ? (verdict.consult ? "consult" : verdict.reason) : "no-decision",
  };
}
