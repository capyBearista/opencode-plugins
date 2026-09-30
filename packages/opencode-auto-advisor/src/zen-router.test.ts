import { describe, expect, test } from "bun:test";
import {
  AIError,
  AuthenticationError,
  HttpContext,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
} from "@opencode/ai";
import type { EvaluationResponseFor } from "@opencode/ai/experimental";
import { defaultConfig } from "./config.js";
import { RouterError } from "./router.js";
import type { RoutingState } from "./routing-types.js";
import { serializeAdvisorContext } from "./serialize.js";
import { ADVISOR_WOULD_HELP_QUESTION, CONSEQUENCE_QUESTION } from "./zen-questions.js";
import {
  createZenRouter,
  MAX_ATTEMPTS_PER_MODEL,
  RETRY_BACKOFF_MS,
  type ZenEvaluationSeam,
} from "./zen-router.js";

type Answer = { readonly model: string; readonly answers: Record<string, unknown> };

const success = (model: string, probability = 0.9, score = 3): Answer => ({
  model,
  answers: {
    [ADVISOR_WOULD_HELP_QUESTION]: { type: "boolean", probability },
    [CONSEQUENCE_QUESTION]: { type: "score", score },
  },
});

const aiError = (reason: ConstructorParameters<typeof AIError>[0]["reason"]) =>
  new AIError({ reason });

const rateLimit = (headers?: Record<string, string>) =>
  aiError(
    new RateLimitError({
      message: "429",
      ...(headers
        ? { http: new HttpContext({ url: "https://zen.test/systemone", status: 429, headers }) }
        : {}),
    }),
  );

function scripted(chain: readonly string[], results: readonly (Answer | Error)[]) {
  const calls: Array<{ modelID: string; state: string; questions: unknown }> = [];
  const sleeps: number[] = [];
  const evaluation: ZenEvaluationSeam = {
    evaluate: async (input) => {
      calls.push(input);
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      if (result instanceof Error) throw result;
      if (!result) throw new Error("no scripted result");
      return result as unknown as EvaluationResponseFor<Record<string, never>>;
    },
  };
  const router = createZenRouter({
    loadConfig: async () => ({
      ...defaultConfig(),
      routing: { ...defaultConfig().routing, models: chain },
    }),
    evaluation,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { router, calls, sleeps };
}

const state = (): RoutingState => ({
  sessionID: "ses_1" as never,
  entries: [{ role: "user", text: "migrate" }],
});

describe("zen router chain", () => {
  test("uses the configured order and restarts from the top on every opportunity", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [
        aiError(new QuotaExceededError({ message: "402" })),
        success("paid"),
        aiError(new QuotaExceededError({ message: "402" })),
        success("paid"),
      ],
    );

    const first = await router.evaluate(state());
    const second = await router.evaluate(state());

    expect(calls.map((call) => call.modelID)).toEqual(["free", "paid", "free", "paid"]);
    expect(first.metadata?.model).toBe("paid");
    expect(second.metadata?.model).toBe("paid");
  });

  test("retries retryable failures up to the per-model bound before falling back", async () => {
    const { router, calls, sleeps } = scripted(
      ["free", "paid"],
      [rateLimit(), rateLimit(), success("paid")],
    );

    const assessment = await router.evaluate(state());

    expect(MAX_ATTEMPTS_PER_MODEL).toBe(2);
    expect(calls.map((call) => call.modelID)).toEqual(["free", "free", "paid"]);
    expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
    expect(assessment.metadata?.attempts).toBe(3);
  });

  test("advances the chain immediately on quota exhaustion", async () => {
    const { router, calls, sleeps } = scripted(
      ["free", "paid"],
      [aiError(new QuotaExceededError({ message: "402" })), success("paid")],
    );

    const assessment = await router.evaluate(state());

    expect(calls.map((call) => call.modelID)).toEqual(["free", "paid"]);
    expect(sleeps).toEqual([]);
    expect(assessment.metadata?.attempts).toBe(2);
  });

  test("stops without trying later models on terminal failures", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [aiError(new AuthenticationError({ message: "401" }))],
    );

    await expect(router.evaluate(state())).rejects.toThrow(RouterError);
    expect(calls.map((call) => call.modelID)).toEqual(["free"]);

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RouterError);
    expect((failure as RouterError).failure).toEqual({
      errorClass: "Authentication",
      model: "free",
      attempts: 1,
    });
  });

  test("fails open with the last model and total attempts when the whole chain fails", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [aiError(new ProviderInternalError({ message: "5xx" }))],
    );

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(calls).toHaveLength(2 * MAX_ATTEMPTS_PER_MODEL);
    expect((failure as RouterError).failure).toEqual({
      errorClass: "ProviderInternal",
      model: "paid",
      attempts: 2 * MAX_ATTEMPTS_PER_MODEL,
    });
  });

  test("honors x-should-retry false over a retryable class", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [rateLimit({ "x-should-retry": "false" })],
    );

    await expect(router.evaluate(state())).rejects.toThrow(RouterError);
    expect(calls.map((call) => call.modelID)).toEqual(["free"]);
  });

  test("evaluates the deterministic serialized transcript with both questions", async () => {
    const { router, calls } = scripted(["free"], [success("free")]);
    const entries = [{ role: "user" as const, text: "migrate" }];

    await router.evaluate({ sessionID: "ses_1" as never, entries });

    expect(calls[0]?.state).toBe(serializeAdvisorContext(entries));
    expect(Object.keys(calls[0]?.questions as object)).toEqual([
      ADVISOR_WOULD_HELP_QUESTION,
      CONSEQUENCE_QUESTION,
    ]);
  });

  test("returns the normalized answers with provider and latency metadata", async () => {
    const { router } = scripted(["free"], [success("free", 0.77, 4)]);

    const assessment = await router.evaluate(state());

    expect(assessment.advisorWouldHelp).toBe(0.77);
    expect(assessment.consequence).toBe(4);
    expect(assessment.metadata?.providerModel).toBe("free");
    expect(typeof assessment.metadata?.latencyMs).toBe("number");
  });
});
