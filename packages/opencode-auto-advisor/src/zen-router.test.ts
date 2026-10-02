import { describe, expect, test } from "bun:test";
import {
  AIError,
  AuthenticationError,
  HttpContext,
  QuotaExceededError,
  RateLimitError,
  TimeoutError,
  TransportError,
} from "@opencode/ai";
import type { EvaluationResponseFor } from "@opencode/ai/experimental";
import { defaultConfig } from "./config.js";
import { buildJevRoutingProjection } from "./jev-projection.js";
import { RouterError } from "./router.js";
import type { RoutingState } from "./routing-types.js";
import type { SerializedEntry } from "./serialize.js";
import { ADVISOR_WOULD_HELP_QUESTION, CONSEQUENCE_QUESTION } from "./zen-questions.js";
import {
  createZenRouter,
  MAX_ATTEMPTS_PER_MODEL,
  RETRY_BACKOFF_MS,
  type ZenEvaluationSeam,
} from "./zen-router.js";

type Answer = { readonly model: string; readonly answers: Record<string, unknown> };

const successWith = (
  model: string,
  probability: number,
  score: number,
  extra: Record<string, unknown> = {},
): Answer => ({
  model,
  answers: {
    [ADVISOR_WOULD_HELP_QUESTION]: { type: "boolean", probability },
    [CONSEQUENCE_QUESTION]: { type: "score", score, ...extra },
  },
});

const success = (model: string, probability = 0.9, score = 3): Answer =>
  successWith(model, probability, score);

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

const transport = (headers?: Record<string, string>) =>
  aiError(
    new TransportError({
      message: "socket",
      transport: "http",
      operation: "request",
      ...(headers
        ? { http: new HttpContext({ url: "https://zen.test/systemone", status: 500, headers }) }
        : {}),
    }),
  );

function scripted(
  chain: readonly string[],
  results: readonly (Answer | Error)[],
  options: { readonly isPublicAuth?: () => Promise<boolean> } = {},
) {
  const calls: Array<{ modelID: string; state: unknown; questions: unknown }> = [];
  const sleeps: number[] = [];
  const evaluation: ZenEvaluationSeam = {
    evaluate: async (input) => {
      calls.push(input);
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      if (result instanceof Error) throw result;
      if (!result) throw new Error("no scripted result");
      return result as unknown as EvaluationResponseFor<Record<string, never>>;
    },
    ...(options.isPublicAuth ? { isPublicAuth: options.isPublicAuth } : {}),
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

  test("retries transient failures on the same model, then fails open without walking the chain", async () => {
    const { router, calls, sleeps } = scripted(
      ["free", "paid"],
      [transport(), transport(), success("paid")],
    );

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(MAX_ATTEMPTS_PER_MODEL).toBe(2);
    expect(calls.map((call) => call.modelID)).toEqual(["free", "free"]);
    expect(sleeps).toEqual([RETRY_BACKOFF_MS]);
    expect(failure).toBeInstanceOf(RouterError);
    expect((failure as RouterError).failure).toEqual({
      errorClass: "Transport",
      model: "free",
      attempts: 2,
      disposition: "retry",
    });
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

  test("advances the chain immediately on model-specific rate limiting", async () => {
    const { router, calls, sleeps } = scripted(["free", "paid"], [rateLimit(), success("paid")]);

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
      disposition: "terminal",
    });
  });

  test("fails open without walking the chain when an evaluation times out", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [aiError(new TimeoutError({ message: "zen evaluation exceeded 5000ms" }))],
    );

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(calls.map((call) => call.modelID)).toEqual(["free"]);
    expect((failure as RouterError).failure).toEqual({
      errorClass: "Timeout",
      model: "free",
      attempts: 1,
      disposition: "terminal",
    });
  });

  test("fails open on an empty model chain without any evaluation", async () => {
    const { router, calls } = scripted([], [success("free")]);

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(RouterError);
    expect((failure as RouterError).failure).toEqual({ errorClass: "InvalidRequest" });
    expect(calls).toHaveLength(0);
  });

  test("stops without walking the chain when the provider output is schema-invalid", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [{ model: "free", answers: { [ADVISOR_WOULD_HELP_QUESTION]: { type: "score", score: 1 } } }],
    );

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(calls.map((call) => call.modelID)).toEqual(["free"]);
    expect((failure as RouterError).failure).toEqual({
      errorClass: "InvalidProviderOutput",
      model: "free",
      attempts: 1,
      disposition: "terminal",
    });
  });

  test("normalizes an exhausted fallback chain to a terminal failure with the last model and total attempts", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [aiError(new QuotaExceededError({ message: "402" }))],
    );

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(calls.map((call) => call.modelID)).toEqual(["free", "paid"]);
    expect((failure as RouterError).failure).toEqual({
      errorClass: "QuotaExceeded",
      model: "paid",
      attempts: 2,
      disposition: "terminal",
    });
  });

  test("x-should-retry false forbids a same-model retry but still allows a capacity fallback", async () => {
    const { router, calls, sleeps } = scripted(
      ["free", "paid"],
      [rateLimit({ "x-should-retry": "false" }), success("paid")],
    );

    const assessment = await router.evaluate(state());

    expect(calls.map((call) => call.modelID)).toEqual(["free", "paid"]);
    expect(sleeps).toEqual([]);
    expect(assessment.metadata?.model).toBe("paid");
  });

  test("x-should-retry false stops transient failures without walking the chain", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [transport({ "x-should-retry": "false" })],
    );

    const failure = await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(calls.map((call) => call.modelID)).toEqual(["free"]);
    expect((failure as RouterError).failure).toEqual({
      errorClass: "Transport",
      model: "free",
      attempts: 1,
      disposition: "terminal",
    });
  });

  test("evaluates the structured Jev routing projection with both questions", async () => {
    const { router, calls } = scripted(["free"], [success("free")]);
    const entries = [{ role: "user" as const, text: "migrate" }];

    await router.evaluate({ sessionID: "ses_1" as never, entries });

    expect(calls[0]?.state).toEqual(buildJevRoutingProjection(entries));
    expect(Object.keys(calls[0]?.questions as object)).toEqual([
      ADVISOR_WOULD_HELP_QUESTION,
      CONSEQUENCE_QUESTION,
    ]);
  });

  test("sends a bounded projection instead of the full transcript", async () => {
    const { router, calls } = scripted(["free"], [success("free")]);
    const entries: SerializedEntry[] = [];
    for (let index = 0; index < 8; index += 1) {
      entries.push({ role: "user", text: `OLD-USER-${index}` });
      entries.push({
        role: "assistant",
        agent: "build",
        model: "opencode/jev-1.13",
        inFlight: false,
        blocks: [{ type: "text", text: `old answer ${index}` }],
      });
    }
    entries.push({ role: "user", text: "CURRENT-MARKER" });

    await router.evaluate({ sessionID: "ses_1" as never, entries });

    const serialized = JSON.stringify(calls[0]?.state);
    expect(serialized).not.toContain("OLD-USER-0");
    expect(serialized).toContain("CURRENT-MARKER");
  });

  test("returns the normalized answers with provider and latency metadata", async () => {
    const { router } = scripted(["free"], [success("free", 0.77, 4)]);

    const assessment = await router.evaluate(state());

    expect(assessment.advisorWouldHelp).toBe(0.77);
    expect(assessment.consequence).toBe(4);
    expect(assessment.metadata?.rawConsequence).toBe(4);
    expect(assessment.metadata?.providerModel).toBe("free");
    expect(typeof assessment.metadata?.latencyMs).toBe("number");
  });

  test("preserves the raw consequence, probabilities, and confidence in metadata", async () => {
    const { router } = scripted(
      ["free"],
      [
        successWith("free", 0.77, 2.6, {
          probabilities: { "0": 0.05, "1": 0.1, "2": 0.6, "3": 0.2, "4": 0.05 },
          confidence: 0.9,
        }),
      ],
    );

    const assessment = await router.evaluate(state());

    expect(assessment.consequence).toBe(3);
    expect(assessment.metadata?.rawConsequence).toBe(2.6);
    expect(assessment.metadata?.consequenceProbabilities).toEqual({
      "0": 0.05,
      "1": 0.1,
      "2": 0.6,
      "3": 0.2,
      "4": 0.05,
    });
    expect(assessment.metadata?.consequenceConfidence).toBe(0.9);
  });
});

describe("session-scoped ineligibility cache", () => {
  const authFailure = () => aiError(new AuthenticationError({ message: "401" }));

  test("skips a cached ineligible model without calling the evaluation seam again", async () => {
    const chain = ["paid"];
    const { router, calls } = scripted(chain, [authFailure()], {
      isPublicAuth: async () => true,
    });

    const first = await router.evaluate(state()).catch((cause: unknown) => cause);
    expect(first).toBeInstanceOf(RouterError);
    expect((first as RouterError).failure).toEqual({
      errorClass: "Authentication",
      model: "paid",
      attempts: 1,
      disposition: "terminal",
    });
    expect(calls).toHaveLength(1);

    const second = await router.evaluate(state()).catch((cause: unknown) => cause);
    expect((second as RouterError).failure).toEqual({
      errorClass: "Authentication",
      model: "paid",
      attempts: 0,
      disposition: "terminal",
    });
    expect(calls).toHaveLength(1);
    expect(chain).toEqual(["paid"]);
  });

  test("continues to the next eligible model after skipping an ineligible one", async () => {
    const { router, calls } = scripted(["paid", "free"], [authFailure(), success("free")], {
      isPublicAuth: async () => true,
    });

    const first = await router.evaluate(state()).catch((cause: unknown) => cause);
    expect((first as RouterError).failure).toEqual({
      errorClass: "Authentication",
      model: "paid",
      attempts: 1,
      disposition: "terminal",
    });

    const second = await router.evaluate(state());
    expect(second.metadata?.model).toBe("free");
    expect(calls.map((call) => call.modelID)).toEqual(["paid", "free"]);
  });

  test("reports a fallback-then-skip chain as the skipped model with zero attempts", async () => {
    const { router, calls } = scripted(
      ["free", "paid"],
      [
        aiError(new QuotaExceededError({ message: "402" })),
        authFailure(),
        aiError(new QuotaExceededError({ message: "402" })),
      ],
      { isPublicAuth: async () => true },
    );

    const first = await router.evaluate(state()).catch((cause: unknown) => cause);
    expect(calls.map((call) => call.modelID)).toEqual(["free", "paid"]);
    expect((first as RouterError).failure).toEqual({
      errorClass: "Authentication",
      model: "paid",
      attempts: 2,
      disposition: "terminal",
    });

    const second = await router.evaluate(state()).catch((cause: unknown) => cause);
    expect(calls.map((call) => call.modelID)).toEqual(["free", "paid", "free"]);
    expect((second as RouterError).failure).toEqual({
      errorClass: "Authentication",
      model: "paid",
      attempts: 0,
      disposition: "terminal",
    });
  });

  test("does not cache authentication failures when the credential is not the public token", async () => {
    const { router, calls } = scripted(["paid"], [authFailure(), authFailure()], {
      isPublicAuth: async () => false,
    });

    await router.evaluate(state()).catch((cause: unknown) => cause);
    await router.evaluate(state()).catch((cause: unknown) => cause);

    expect(calls.map((call) => call.modelID)).toEqual(["paid", "paid"]);
  });

  test("a missing or failing public-auth probe leaves the cache disabled", async () => {
    const missing = scripted(["paid"], [authFailure(), authFailure()]);
    await missing.router.evaluate(state()).catch((cause: unknown) => cause);
    await missing.router.evaluate(state()).catch((cause: unknown) => cause);
    expect(missing.calls).toHaveLength(2);

    const failing = scripted(["paid"], [authFailure(), authFailure()], {
      isPublicAuth: async () => {
        throw new Error("connection lookup failed");
      },
    });
    await failing.router.evaluate(state()).catch((cause: unknown) => cause);
    await failing.router.evaluate(state()).catch((cause: unknown) => cause);
    expect(failing.calls).toHaveLength(2);
  });

  test("keeps ineligibility scoped to the session", async () => {
    const { router, calls } = scripted(["paid"], [authFailure(), authFailure()], {
      isPublicAuth: async () => true,
    });

    await router.evaluate(state()).catch((cause: unknown) => cause);
    await router
      .evaluate({ ...state(), sessionID: "ses_2" as never })
      .catch((cause: unknown) => cause);

    expect(calls).toHaveLength(2);
  });

  test("forget clears the cached ineligibility for a session", async () => {
    const { router, calls } = scripted(["paid"], [authFailure(), authFailure()], {
      isPublicAuth: async () => true,
    });

    await router.evaluate(state()).catch((cause: unknown) => cause);
    await router.evaluate(state()).catch((cause: unknown) => cause);
    expect(calls).toHaveLength(1);

    router.forget?.("ses_1" as never);
    await router.evaluate(state()).catch((cause: unknown) => cause);
    expect(calls).toHaveLength(2);
  });
});
