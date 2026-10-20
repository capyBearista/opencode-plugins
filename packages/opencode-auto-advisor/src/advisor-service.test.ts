import { describe, expect, test } from "bun:test";
import {
  AdvisorInvalidatedError,
  type AdvisorServiceDeps,
  AdvisorTimeoutError,
  createAdvisorService,
} from "./advisor-service.js";
import { type AdvisorConfig, defaultConfig } from "./config.js";

function deps(config: AdvisorConfig) {
  const calls: Array<{ prompt: string; model?: unknown }> = [];
  const service = createAdvisorService({
    loadConfig: async () => config,
    generateText: async (input) => {
      calls.push(input);
      return { text: "Consider the failure path." };
    },
  });
  return { service, calls };
}

function configWithTimeout(timeoutMs: number): AdvisorConfig {
  return { ...defaultConfig(), advisor: { timeoutMs } };
}

describe("createAdvisorService", () => {
  test("omitted advisor.model inherits the executor model for that consultation", async () => {
    const { service, calls } = deps(defaultConfig());
    const result = await service.consult({
      transcript: "[[context]]",
      executorModel: { providerID: "opencode", id: "jev-1.14" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toEqual({ providerID: "opencode", id: "jev-1.14" });
    expect(result.model).toEqual({ providerID: "opencode", id: "jev-1.14" });
    expect(result.advice).toBe("Consider the failure path.");
  });

  test("explicit advisor.model wins over the executor model", async () => {
    const { service, calls } = deps({
      ...defaultConfig(),
      advisor: { model: { providerID: "anthropic", id: "claude-sonnet-4" } },
    });
    const result = await service.consult({
      transcript: "[[context]]",
      executorModel: { providerID: "opencode", id: "jev-1.14" },
    });
    expect(calls[0]?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4" });
    expect(result.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4" });
  });

  test("omits the model when neither the config nor the executor provides one", async () => {
    const { service, calls } = deps(defaultConfig());
    const result = await service.consult({ transcript: "[[context]]" });
    expect(calls[0]?.model).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  test("builds a fresh prompt from the transcript with advisor instructions", async () => {
    const { service, calls } = deps(defaultConfig());
    await service.consult({ transcript: '{"role":"user","text":"ship it"}' });
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("Auto Advisor");
    expect(prompt).toContain('{"role":"user","text":"ship it"}');
    expect(prompt).toContain("not inspected");
  });

  test("propagates generation failures to the caller", async () => {
    const failing: AdvisorServiceDeps = {
      loadConfig: async () => defaultConfig(),
      generateText: async () => {
        throw new Error("provider exploded");
      },
    };
    await expect(
      createAdvisorService(failing).consult({ transcript: "[[context]]" }),
    ).rejects.toThrow("provider exploded");
  });

  test("does not retain state between consultations", async () => {
    const { service, calls } = deps(defaultConfig());
    await service.consult({ transcript: "first" });
    await service.consult({
      transcript: "second",
      executorModel: { providerID: "opencode", id: "jev-1.13" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).not.toBe(calls[1]?.prompt);
    expect(calls[0]?.model).toBeUndefined();
  });

  test("resolves a response before the soft deadline", async () => {
    const service = createAdvisorService({
      loadConfig: async () => configWithTimeout(1000),
      generateText: async () => ({ text: "early advice" }),
    });
    await expect(service.consult({ transcript: "[[context]]" })).resolves.toEqual({
      advice: "early advice",
    });
  });

  test("rejects with AdvisorTimeoutError when the soft deadline passes", async () => {
    const calls: Array<{ prompt: string; model?: unknown }> = [];
    const service = createAdvisorService({
      loadConfig: async () => configWithTimeout(20),
      generateText: (input) => {
        calls.push(input);
        return new Promise<{ readonly text: string }>(() => undefined);
      },
    });
    const error = await service
      .consult({
        transcript: "[[context]]",
        executorModel: { providerID: "opencode", id: "jev-1.13" },
      })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(AdvisorTimeoutError);
    expect(error.name).toBe("AdvisorTimeoutError");
    expect(error.message).toContain("timed out");
    expect(error.message).toContain("20");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toEqual({ providerID: "opencode", id: "jev-1.13" });
  });

  test("propagates a provider error directly with exactly one generation call", async () => {
    const calls: unknown[] = [];
    const service = createAdvisorService({
      loadConfig: async () => configWithTimeout(1000),
      generateText: async (input) => {
        calls.push(input);
        throw new Error("provider exploded");
      },
    });
    await expect(service.consult({ transcript: "[[context]]" })).rejects.toThrow(
      "provider exploded",
    );
    expect(calls).toHaveLength(1);
  });

  test("absorbs a late resolution after the deadline without a second generation", async () => {
    let settle: (value: { readonly text: string }) => void = () => undefined;
    const calls: unknown[] = [];
    const service = createAdvisorService({
      loadConfig: async () => configWithTimeout(10),
      generateText: (input) => {
        calls.push(input);
        return new Promise<{ readonly text: string }>((resolve) => {
          settle = resolve;
        });
      },
    });
    await expect(service.consult({ transcript: "[[context]]" })).rejects.toBeInstanceOf(
      AdvisorTimeoutError,
    );
    settle({ text: "too late" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(1);
  });

  test("absorbs a late rejection after the deadline without unhandled rejection", async () => {
    let fail: (cause: unknown) => void = () => undefined;
    const service = createAdvisorService({
      loadConfig: async () => configWithTimeout(10),
      generateText: () =>
        new Promise<{ readonly text: string }>((_resolve, reject) => {
          fail = reject;
        }),
    });
    await expect(service.consult({ transcript: "[[context]]" })).rejects.toBeInstanceOf(
      AdvisorTimeoutError,
    );
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    fail(new Error("late provider failure"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
  });

  test("uses the caller-selected advisorModel without reselecting the configured model", async () => {
    const { service, calls } = deps({
      ...defaultConfig(),
      advisor: { model: { providerID: "anthropic", id: "claude-sonnet-4" } },
    });
    const selected = { providerID: "opencode", id: "jev-1.14" };
    const result = await service.consult({
      transcript: "[[context]]",
      executorModel: { providerID: "opencode", id: "jev-1.13" },
      advisorModel: selected,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toEqual(selected);
    expect(result.model).toEqual(selected);
  });

  test("returns qualitative advice with no confidence field", async () => {
    const { service } = deps(defaultConfig());
    const result = await service.consult({ transcript: "[[context]]" });
    expect(Object.keys(result).sort()).toEqual(["advice"]);
    expect(result.advice).toBe("Consider the failure path.");
  });

  test("invokes onStart exactly once immediately before generation", async () => {
    const order: string[] = [];
    const service = createAdvisorService({
      loadConfig: async () => {
        order.push("config");
        return defaultConfig();
      },
      generateText: async () => {
        order.push("generate");
        return { text: "advice" };
      },
    });

    await service.consult({ transcript: "[[context]]", onStart: () => order.push("start") });

    expect(order).toEqual(["config", "start", "generate"]);
  });

  test("does not invoke onStart when configuration loading fails", async () => {
    let started = 0;
    const service = createAdvisorService({
      loadConfig: async () => {
        throw new Error("configuration unreadable");
      },
      generateText: async () => ({ text: "advice" }),
    });

    await expect(
      service.consult({ transcript: "[[context]]", onStart: () => (started += 1) }),
    ).rejects.toThrow("configuration unreadable");
    expect(started).toBe(0);
  });

  test("keeps generation working when onStart throws", async () => {
    const calls: unknown[] = [];
    const service = createAdvisorService({
      loadConfig: async () => defaultConfig(),
      generateText: async (input) => {
        calls.push(input);
        return { text: "advice despite a throwing callback" };
      },
    });

    const result = await service.consult({
      transcript: "[[context]]",
      onStart: () => {
        throw new Error("lifecycle observer exploded");
      },
    });

    expect(calls).toHaveLength(1);
    expect(result.advice).toBe("advice despite a throwing callback");
  });
});

describe("operation invalidation", () => {
  test("rejects with a clear error when invalidated during the config load", async () => {
    let current = true;
    let release: () => void = () => undefined;
    const calls: unknown[] = [];
    const service = createAdvisorService({
      loadConfig: () =>
        new Promise((resolve) => {
          release = () => resolve(defaultConfig());
        }),
      generateText: async (input) => {
        calls.push(input);
        return { text: "advice" };
      },
    });

    const pending = service.consult({ transcript: "[[context]]", isCurrent: () => current });
    current = false;
    release();
    const error = await pending.catch((cause) => cause);

    expect(error).toBeInstanceOf(AdvisorInvalidatedError);
    expect(error.message).toContain("invalidated");
    expect(calls).toHaveLength(0);
  });

  test("checks after onStart and never starts generation when invalidated", async () => {
    let current = true;
    const order: string[] = [];
    const service = createAdvisorService({
      loadConfig: async () => {
        order.push("config");
        return defaultConfig();
      },
      generateText: async () => {
        order.push("generate");
        return { text: "advice" };
      },
    });

    const error = await service
      .consult({
        transcript: "[[context]]",
        onStart: () => {
          order.push("start");
          current = false;
        },
        isCurrent: () => current,
      })
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(AdvisorInvalidatedError);
    expect(order).toEqual(["config", "start"]);
  });

  test("rejects after a response that resolves post-invalidation", async () => {
    let current = true;
    const calls: unknown[] = [];
    const service = createAdvisorService({
      loadConfig: async () => defaultConfig(),
      generateText: async (input) => {
        calls.push(input);
        current = false;
        return { text: "late advice" };
      },
    });

    await expect(
      service.consult({ transcript: "[[context]]", isCurrent: () => current }),
    ).rejects.toBeInstanceOf(AdvisorInvalidatedError);
    expect(calls).toHaveLength(1);
  });

  test("defaults to current without a predicate", async () => {
    const { service, calls } = deps(defaultConfig());

    await expect(service.consult({ transcript: "[[context]]" })).resolves.toEqual({
      advice: "Consider the failure path.",
    });
    expect(calls).toHaveLength(1);
  });
});
