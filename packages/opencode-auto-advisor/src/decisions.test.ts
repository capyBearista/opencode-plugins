import { describe, expect, test } from "bun:test";
import { DEFAULTS, type ModelRef } from "./config.js";
import {
  ATTEMPT_TIMEOUT_MS,
  createRouter,
  type DecisionRequest,
  type DecisionResult,
  QUESTIONS,
  SKIP_MS,
} from "./decisions.js";
import fixtures from "./fixtures/s1-decisions.json";
import { decide, read } from "./policy.js";

const free: ModelRef = { providerID: "opencode", id: "jev-1.13-free" };
const paid: ModelRef = { providerID: "opencode", id: "jev-1.13" };
const ok = fixtures.ok as DecisionResult;
const rateLimited = {
  _tag: "Generate.ProviderRequestError",
  providerID: "opencode",
  reason: "rate_limit",
  message: "slow down",
};

function fakeGenerate(script: Record<string, unknown[]>) {
  const calls: DecisionRequest[] = [];
  const generate = async (request: DecisionRequest) => {
    calls.push(request);
    const next = script[`${request.model.providerID}/${request.model.id}`]?.shift();
    if (next instanceof Promise) return next as Promise<DecisionResult>;
    if (next && typeof next === "object" && "_tag" in next) throw next;
    if (next === undefined) throw new Error("unexpected call");
    return next as DecisionResult;
  };
  return { generate, calls };
}

describe("router", () => {
  test("sends the two questions and the projection to the first model", async () => {
    const { generate, calls } = fakeGenerate({ "opencode/jev-1.13-free": [ok] });
    const result = await createRouter(generate)([free], "state");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].questions).toBe(QUESTIONS);
    expect(calls[0].input).toEqual([{ type: "text", text: "state" }]);
  });

  test.each(Object.entries(fixtures.errors))("%s moves to the next model", async (_name, error) => {
    const { generate } = fakeGenerate({
      "opencode/jev-1.13-free": [error],
      "opencode/jev-1.13": [ok],
    });
    const result = await createRouter(generate)([free, paid], "state");
    expect(result.ok && result.model).toBe("opencode/jev-1.13");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["next", "ok"]);
  });

  test("an invalid request stops without trying other models", async () => {
    const invalid = { ...rateLimited, reason: "invalid_request" };
    const { generate, calls } = fakeGenerate({
      "opencode/jev-1.13-free": [invalid],
      "opencode/jev-1.13": [ok],
    });
    const result = await createRouter(generate)([free, paid], "state");
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("an unknown error stops", async () => {
    const { generate } = fakeGenerate({ "opencode/jev-1.13-free": [{ _tag: "SchemaError" }] });
    expect((await createRouter(generate)([free, paid], "state")).ok).toBe(false);
  });

  test("a rate-limited model is skipped until the skip window passes", async () => {
    let clock = 1_000;
    const { generate, calls } = fakeGenerate({
      "opencode/jev-1.13-free": [rateLimited, ok],
      "opencode/jev-1.13": [ok, ok],
    });
    const route = createRouter(generate, () => clock);
    await route([free, paid], "a");
    const second = await route([free, paid], "b");
    expect(second.attempts.map((a) => a.outcome)).toEqual(["skipped", "ok"]);
    clock += SKIP_MS + 1;
    const third = await route([free, paid], "c");
    expect(third.ok && third.model).toBe("opencode/jev-1.13-free");
    expect(calls.map((c) => c.model.id)).toEqual([
      "jev-1.13-free",
      "jev-1.13",
      "jev-1.13",
      "jev-1.13-free",
    ]);
  });

  test("a hung model times out and the next model answers", async () => {
    const hung = new Promise<DecisionResult>(() => {});
    const { generate } = fakeGenerate({
      "opencode/jev-1.13-free": [hung],
      "opencode/jev-1.13": [ok],
    });
    const start = Date.now();
    const result = await createRouter(generate)([free, paid], "state");
    expect(result.ok && result.model).toBe("opencode/jev-1.13");
    expect(result.attempts[0].outcome).toBe("timeout");
    expect(Date.now() - start).toBeGreaterThanOrEqual(ATTEMPT_TIMEOUT_MS - 50);
  }, 15_000);

  test("a response missing an answer is not a selection", async () => {
    const partial = { answers: [ok.answers[0]] };
    const { generate } = fakeGenerate({ "opencode/jev-1.13-free": [partial] });
    expect((await createRouter(generate)([free], "state")).ok).toBe(false);
  });
});

const answers = (probs: Record<string, number>, score: number) => [
  {
    name: "moment",
    type: "choice",
    choice: "x",
    probabilities: Object.entries(probs).map(([value, probability]) => ({ value, probability })),
  },
  { name: "consequence", type: "score", score },
];

describe("policy", () => {
  const routing = DEFAULTS.routing;

  test("real S1 answer (stuck, 2.49) consults with the defaults", () => {
    const verdict = decide({ answers: ok.answers, routing });
    expect(verdict.consult).toBe(true);
    expect(verdict.reading?.moment).toBe("stuck");
    expect(verdict.reading?.consequence).toBeCloseTo(2.49);
  });

  test("routine moments do not consult", () => {
    const verdict = decide({ answers: answers({ routine: 0.8, approach: 0.2 }, 3), routing });
    expect(verdict).toMatchObject({ consult: false, reason: "routine" });
  });

  test("the raw score is compared, never rounded", () => {
    const below = decide({ answers: answers({ done: 1 }, 1.49), routing });
    const at = decide({ answers: answers({ done: 1 }, 1.5), routing });
    expect(below).toMatchObject({ consult: false, reason: "low-consequence" });
    expect(at.consult).toBe(true);
  });

  test("a declined question means no consult", () => {
    const declined = [ok.answers[0], { name: "consequence", type: "error", reason: "refusal" }];
    expect(decide({ answers: declined, routing })).toMatchObject({
      consult: false,
      reason: "unanswered",
    });
  });

  test("the moment is the likeliest non-routine one", () => {
    expect(read(answers({ approach: 0.3, stuck: 0.5, routine: 0.2 }, 2))?.moment).toBe("stuck");
  });

  test("a consult never carries the routine label", () => {
    const even = { approach: 0.25, stuck: 0.25, done: 0.25, routine: 0.25 };
    const verdict = decide({ answers: answers(even, 3), routing });
    expect(verdict.consult).toBe(true);
    expect(verdict.reading?.moment).not.toBe("routine");
  });
  });
});
