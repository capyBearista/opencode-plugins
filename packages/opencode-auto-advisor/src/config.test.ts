import { describe, expect, test } from "bun:test";
import { DEFAULTS, parseConfig, parseModelRef, resolveConfigPath } from "./config.js";

describe("parseConfig", () => {
  test("empty object yields every default", () => {
    expect(parseConfig({})).toEqual(DEFAULTS);
  });

  test("sparse values override only their keys", () => {
    const config = parseConfig({ routing: { mode: "active", consequenceThreshold: 3 } });
    expect(config.routing.mode).toBe("active");
    expect(config.routing.consequenceThreshold).toBe(3);
    expect(config.routing.models).toEqual(DEFAULTS.routing.models);
    expect(config.advisor).toEqual(DEFAULTS.advisor);
  });

  test("defaults match the agreed values", () => {
    expect(DEFAULTS).toEqual({
      advisor: { model: undefined, timeoutMs: 300_000, compactContext: true, maxTokens: 64_000 },
      routing: {
        mode: "active",
        models: [{ providerID: "opencode", id: "jev-1.13-free" }],
        momentThreshold: 0.7,
        consequenceThreshold: 1.5,
        maxConsultationsPerTurn: 1,
        minStepsBetweenConsultations: 10,
        requests: 3,
        requestMaxChars: -1,
      },
      tui: { sidebar: true },
    });
  });

  test("routing.requests and routing.requestMaxChars accept their ranges; -1 is no cap", () => {
    const config = parseConfig({ routing: { requests: 1, requestMaxChars: 100 } });
    expect(config.routing.requests).toBe(1);
    expect(config.routing.requestMaxChars).toBe(100);
    expect(parseConfig({ routing: { requestMaxChars: -1 } }).routing.requestMaxChars).toBe(-1);
    expect(parseConfig({ routing: { requests: 20 } }).routing.requests).toBe(20);
  });

  test("advisor.maxTokens accepts an integer of at least 1000", () => {
    expect(parseConfig({ advisor: { maxTokens: 1_000 } }).advisor.maxTokens).toBe(1_000);
  });

  test("routing.minStepsBetweenConsultations accepts 0 to turn the cooldown off", () => {
    const config = parseConfig({ routing: { minStepsBetweenConsultations: 0 } });
    expect(config.routing.minStepsBetweenConsultations).toBe(0);
  });

  test("tui.sidebar accepts a boolean", () => {
    expect(parseConfig({ tui: { sidebar: false } }).tui.sidebar).toBe(false);
  });

  test("advisor.compactContext accepts a boolean", () => {
    expect(parseConfig({ advisor: { compactContext: false } }).advisor.compactContext).toBe(false);
  });

  test("advisor.model accepts provider/model and inherit", () => {
    expect(parseConfig({ advisor: { model: "openai/gpt-6" } }).advisor.model).toEqual({
      providerID: "openai",
      id: "gpt-6",
    });
    expect(parseConfig({ advisor: { model: "inherit" } }).advisor.model).toBeUndefined();
    expect(parseConfig({ advisor: { model: "openai/gpt-6#high" } }).advisor.model).toEqual({
      providerID: "openai",
      id: "gpt-6",
      variant: "high",
    });
  });

  test("routing.models keeps order and splits on the first slash", () => {
    const config = parseConfig({
      routing: { models: ["openrouter/typesafe/jev-1.13", "opencode/jev-1.13-free"] },
    });
    expect(config.routing.models).toEqual([
      { providerID: "openrouter", id: "typesafe/jev-1.13" },
      { providerID: "opencode", id: "jev-1.13-free" },
    ]);
  });

  test.each([
    [{ extra: 1 }, "unknown key: extra"],
    [{ routing: { mode: "on" } }, "routing.mode"],
    [{ routing: { models: [] } }, "routing.models"],
    [{ routing: { models: ["a/b", "a/b"] } }, "routing.models"],
    [{ routing: { models: Array.from({ length: 9 }, (_, i) => `p/m${i}`) } }, "routing.models"],
    [{ routing: { models: ["noslash"] } }, "routing.models"],
    [{ routing: { momentThreshold: 1.2 } }, "routing.momentThreshold"],
    [{ routing: { consequenceThreshold: -1 } }, "routing.consequenceThreshold"],
    [{ routing: { consequenceThreshold: 5 } }, "routing.consequenceThreshold"],
    [{ routing: { maxConsultationsPerTurn: 0 } }, "routing.maxConsultationsPerTurn"],
    [{ routing: { maxConsultationsPerTurn: 1.5 } }, "routing.maxConsultationsPerTurn"],
    [{ routing: { minStepsBetweenConsultations: -1 } }, "routing.minStepsBetweenConsultations"],
    [{ routing: { minStepsBetweenConsultations: 2.5 } }, "routing.minStepsBetweenConsultations"],
    [{ routing: { requests: 0 } }, "routing.requests"],
    [{ routing: { requests: 21 } }, "routing.requests"],
    [{ routing: { requests: 1.5 } }, "routing.requests"],
    [{ routing: { requestMaxChars: 0 } }, "routing.requestMaxChars"],
    [{ routing: { requestMaxChars: 99 } }, "routing.requestMaxChars"],
    [{ routing: { requestMaxChars: -2 } }, "routing.requestMaxChars"],
    [{ routing: { requestMaxChars: 150.5 } }, "routing.requestMaxChars"],
    [{ advisor: { timeoutMs: 0 } }, "advisor.timeoutMs"],
    [{ advisor: { model: "x" } }, "advisor.model"],
    [{ advisor: { compactContext: "yes" } }, "advisor.compactContext"],
    [{ advisor: { maxTokens: 64 } }, "advisor.maxTokens must be"],
    [{ advisor: { maxTokens: 1_500.5 } }, "advisor.maxTokens must be"],
    [{ advisor: { other: 1 } }, "unknown key: advisor.other"],
    [{ tui: { sidebar: "yes" } }, "tui.sidebar"],
    [{ tui: { footer: true } }, "unknown key: tui.footer"],
    [[], "must be a JSON object"],
  ])("rejects %j", (input, message) => {
    expect(() => parseConfig(input)).toThrow(message);
  });
});

describe("parseModelRef", () => {
  test("rejects empty halves", () => {
    expect(parseModelRef("/x")).toBeUndefined();
    expect(parseModelRef("x/")).toBeUndefined();
    expect(parseModelRef("a/b")).toEqual({ providerID: "a", id: "b" });
  });

  test("reads an optional #variant after the model", () => {
    expect(parseModelRef("openrouter/meta/muse#xhigh")).toEqual({
      providerID: "openrouter",
      id: "meta/muse",
      variant: "xhigh",
    });
    expect(parseModelRef("a/b#")).toBeUndefined();
    expect(parseModelRef("a/#high")).toBeUndefined();
    expect(parseModelRef("a/b#c#d")).toBeUndefined();
    expect(parseModelRef("a#x/b")).toBeUndefined();
  });
});

describe("resolveConfigPath", () => {
  test("prefers OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then home", () => {
    expect(resolveConfigPath({ OPENCODE_CONFIG_DIR: "/c" }, "/h")).toBe("/c/auto-advisor.json");
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe(
      "/x/opencode/auto-advisor.json",
    );
    expect(resolveConfigPath({}, "/h")).toBe("/h/.config/opencode/auto-advisor.json");
  });
});
