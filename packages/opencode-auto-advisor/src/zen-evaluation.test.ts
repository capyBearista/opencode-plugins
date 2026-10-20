import { describe, expect, test } from "bun:test";
import { AIError } from "@opencode/ai";
import { createZenEvaluation, ZEN_CALL_TIMEOUT_MS } from "./zen-evaluation.js";
import { buildZenQuestions } from "./zen-questions.js";

const connectionInfo = { type: "credential", id: "cred-1" } as never;

function systemOneResponse(probability: number, score: number) {
  return {
    model: "jev-1.13-free",
    answers: {
      advisor_would_help: { type: "noul", noul: probability },
      consequence: {
        type: "score",
        score,
        probabilities: { "0": 0, "1": 0, "2": 0.1, "3": 0.9, "4": 0 },
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function startStandIn() {
  const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.json();
      requests.push({
        url: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      return Response.json(systemOneResponse(0.91, 3));
    },
  });
  return { server, requests, baseURL: `http://127.0.0.1:${server.port}` };
}

describe("zen evaluation", () => {
  test("bounds every provider call with the tightened 5s internal deadline", () => {
    expect(ZEN_CALL_TIMEOUT_MS).toBe(5_000);
  });

  test("runs the Evaluation client against a System One stand-in with the public bearer", async () => {
    const stand = startStandIn();
    const evaluation = createZenEvaluation({ baseURL: stand.baseURL });
    try {
      const response = await evaluation.evaluate({
        modelID: "jev-1.13-free",
        state: "[]",
        questions: buildZenQuestions(),
      });

      expect(response.answers.advisor_would_help).toEqual({ type: "boolean", probability: 0.91 });
      expect(response.answers.consequence).toMatchObject({ type: "score", score: 3 });
      expect(stand.requests).toHaveLength(1);
      expect(stand.requests[0]?.url).toBe("/systemone");
      expect(stand.requests[0]?.authorization).toBe("Bearer public");
      const body = stand.requests[0]?.body as {
        model: string;
        questions: Record<string, { type: string }>;
      };
      expect(body.model).toBe("jev-1.13-free");
      expect(body.questions.advisor_would_help?.type).toBe("noul");
      expect(body.questions.consequence?.type).toBe("score");
    } finally {
      await evaluation.dispose();
      stand.server.stop(true);
    }
  });

  test("uses the resolved integration credential as the bearer token", async () => {
    const stand = startStandIn();
    const evaluation = createZenEvaluation({
      baseURL: stand.baseURL,
      connection: {
        active: async () => connectionInfo,
        resolve: async () => ({ type: "key", key: "secret-key" }) as never,
      },
    });
    try {
      await evaluation.evaluate({
        modelID: "jev-1.13",
        state: "[]",
        questions: buildZenQuestions(),
      });
      expect(stand.requests[0]?.authorization).toBe("Bearer secret-key");
    } finally {
      await evaluation.dispose();
      stand.server.stop(true);
    }
  });

  test("reports whether the active Zen credential is the public bearer", async () => {
    const publicEvaluation = createZenEvaluation({ baseURL: "http://127.0.0.1:1" });
    const keyedEvaluation = createZenEvaluation({
      baseURL: "http://127.0.0.1:1",
      connection: {
        active: async () => connectionInfo,
        resolve: async () => ({ type: "key", key: "secret-key" }) as never,
      },
    });
    try {
      expect(await publicEvaluation.isPublicAuth()).toBe(true);
      expect(await keyedEvaluation.isPublicAuth()).toBe(false);
    } finally {
      await publicEvaluation.dispose();
      await keyedEvaluation.dispose();
    }
  });

  test("propagates classified provider failures as AIError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    });
    const evaluation = createZenEvaluation({ baseURL: `http://127.0.0.1:${server.port}` });
    try {
      const failure = await evaluation
        .evaluate({ modelID: "jev-1.13-free", state: "[]", questions: buildZenQuestions() })
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AIError);
      expect((failure as AIError).reason._tag).toBe("RateLimit");
    } finally {
      await evaluation.dispose();
      server.stop(true);
    }
  });

  test("refuses evaluation after dispose instead of recreating the runtime", async () => {
    const evaluation = createZenEvaluation({ baseURL: "http://127.0.0.1:1" });
    await evaluation.dispose();
    await evaluation.dispose();
    const failure = await evaluation
      .evaluate({ modelID: "jev-1.13-free", state: "[]", questions: buildZenQuestions() })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("zen evaluation runtime disposed");
  });

  test("dispose interrupts an in-flight evaluation instead of leaking the runtime", async () => {
    const started = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        started.resolve();
        return new Promise<Response>(() => undefined);
      },
    });
    const evaluation = createZenEvaluation({ baseURL: `http://127.0.0.1:${server.port}` });
    try {
      const pending = evaluation.evaluate({
        modelID: "jev-1.13-free",
        state: "[]",
        questions: buildZenQuestions(),
      });
      await started.promise;
      await evaluation.dispose();
      const failure = await pending.catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(Error);
    } finally {
      server.stop(true);
    }
  });

  test("aborts a hung provider call with a classified Timeout error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => undefined),
    });
    const evaluation = createZenEvaluation({
      baseURL: `http://127.0.0.1:${server.port}`,
      timeoutMs: 25,
    });
    try {
      const failure = await evaluation
        .evaluate({ modelID: "jev-1.13-free", state: "[]", questions: buildZenQuestions() })
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AIError);
      expect((failure as AIError).reason._tag).toBe("Timeout");
    } finally {
      await evaluation.dispose();
      server.stop(true);
    }
  });
});
