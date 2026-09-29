import { describe, expect, test } from "bun:test";
import { type AdvisorServiceDeps, createAdvisorService } from "./advisor-service.js";
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
});
