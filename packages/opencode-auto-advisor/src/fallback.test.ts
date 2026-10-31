import { describe, expect, test } from "bun:test";
import { classify, createWalker } from "./fallback.js";

const provider = (reason: string) => ({ _tag: "Generate.ProviderRequestError", reason });
const key = (entry: string) => entry;

describe("classify", () => {
  test.each([
    [provider("invalid_request"), "next", false],
    [provider("rate_limit"), "next", true],
    [provider("overloaded"), "next", true],
    [provider("provider"), "next", false],
    [provider("authentication"), "next", false],
    [provider("content_filter"), "stop", false],
    [{ _tag: "Generate.ModelNotFoundError" }, "next", false],
    [{ _tag: "Generate.UnsupportedModelError" }, "next", false],
    [{ _tag: "Generate.UnavailableError" }, "next", false],
    [{ _tag: "Advisor.EmptyAdvice" }, "next", false],
    [{ _tag: "Generate.InvalidRequestError", field: "model.variant" }, "stop", false],
    [new Error("boom"), "stop", false],
  ])("%j → %s (skip %s)", (error, action, skip) => {
    expect(classify(error)).toMatchObject({ action, skip });
  });

  test("names the reason of a provider error", () => {
    expect(classify(provider("rate_limit")).error).toBe(
      "Generate.ProviderRequestError (rate_limit)",
    );
  });
});

describe("walker", () => {
  test("an unlimited deadline waits for a slow model instead of timing out", async () => {
    const walk = createWalker();
    const result = await walk({
      entries: ["slow"],
      key,
      call: () => Bun.sleep(30).then(() => "answer"),
      attemptMs: Number.POSITIVE_INFINITY,
      totalMs: Number.POSITIVE_INFINITY,
    });
    expect(result).toMatchObject({ ok: true, model: "slow", value: "answer" });
  });

  test("models share one total deadline; the next gets only what remains", async () => {
    const walk = createWalker();
    const start = Date.now();
    const result = await walk({
      entries: ["fails", "hangs", "never"],
      key,
      call: (entry) =>
        entry === "fails"
          ? Bun.sleep(40).then(() => Promise.reject(provider("provider")))
          : new Promise<string>(() => {}),
      attemptMs: Number.POSITIVE_INFINITY,
      totalMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts.map((a) => [a.model, a.outcome])).toEqual([
      ["fails", "next"],
      ["hangs", "timeout"],
    ]);
    expect(Date.now() - start).toBeLessThan(150);
  });

  test("a failure that is not the model's moves on at once without a skip", async () => {
    const walk = createWalker();
    const calls: string[] = [];
    const run = () =>
      walk({
        entries: ["small", "large"],
        key,
        call: async (entry) => {
          calls.push(entry);
          if (entry === "small") throw provider("invalid_request");
          return "ok";
        },
        attemptMs: 1_000,
        totalMs: 1_000,
      });
    expect((await run()).attempts.map((a) => a.outcome)).toEqual(["next", "ok"]);
    // No skip: a smaller input next time may fit the small model.
    await run();
    expect(calls).toEqual(["small", "large", "small", "large"]);
  });
});
