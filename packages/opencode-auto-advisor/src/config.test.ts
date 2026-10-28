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

  test("defaults match the agreed v1 values", () => {
    expect(DEFAULTS).toEqual({
      advisor: { model: undefined, timeoutMs: 300_000 },
      routing: {
        mode: "off",
        models: [{ providerID: "opencode", id: "jev-1.13-free" }],
        momentThreshold: 0.7,
        consequenceThreshold: 1.5,
        maxConsultationsPerTurn: 2,
      },
    });
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
    [{ advisor: { timeoutMs: 0 } }, "advisor.timeoutMs"],
    [{ advisor: { model: "x" } }, "advisor.model"],
    [{ advisor: { other: 1 } }, "unknown key: advisor.other"],
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
