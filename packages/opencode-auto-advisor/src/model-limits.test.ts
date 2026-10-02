import { describe, expect, test } from "bun:test";
import type { ModelReference } from "./messages.js";
import {
  ADVISOR_RESERVE_FRACTION,
  computeInputBudget,
  createModelLimitResolver,
  findModelLimits,
  type ModelLimitEntry,
} from "./model-limits.js";

const JEV: ModelReference = { providerID: "opencode", id: "jev-1.13" };

function entry(overrides: Partial<ModelLimitEntry> = {}): ModelLimitEntry {
  return {
    id: "jev-1.13",
    providerID: "opencode",
    modelID: "jev-1.13",
    limit: { context: 200_000, output: 32_000 },
    ...overrides,
  };
}

describe("findModelLimits", () => {
  test("resolves the advertised limits of the selected model", () => {
    expect(findModelLimits([entry()], JEV)).toEqual({
      context: 200_000,
      output: 32_000,
    });
  });

  test("matches on the modelID key the host catalog uses", () => {
    expect(findModelLimits([entry({ id: "other" })], JEV)).toEqual({
      context: 200_000,
      output: 32_000,
    });
  });

  test("matches on the id key when the catalog carries it", () => {
    expect(findModelLimits([entry({ modelID: "other" })], JEV)).toEqual({
      context: 200_000,
      output: 32_000,
    });
  });

  test("keeps an advertised input limit", () => {
    expect(
      findModelLimits(
        [entry({ limit: { context: 200_000, input: 100_000, output: 32_000 } })],
        JEV,
      ),
    ).toEqual({
      context: 200_000,
      input: 100_000,
      output: 32_000,
    });
  });

  test("ignores unrelated models", () => {
    expect(findModelLimits([entry({ id: "claude", modelID: "claude" })], JEV)).toBeUndefined();
  });

  test("fails open on unknown models", () => {
    expect(findModelLimits([], JEV)).toBeUndefined();
  });

  for (const limit of [
    undefined,
    { context: Number.NaN, output: 32_000 },
    { context: 0, output: 32_000 },
    { context: -1, output: 32_000 },
    { context: 200_000.5, output: 32_000 },
    { context: 200_000 },
    { context: 200_000, output: Number.POSITIVE_INFINITY },
    { context: 200_000, output: 0 },
    { context: 200_000, output: 32_000, input: Number.NaN },
    { context: 200_000, output: 32_000, input: 0 },
    { context: 200_000, output: 32_000, input: -5 },
  ]) {
    test(`fails open on malformed limits ${JSON.stringify(limit)}`, () => {
      expect(
        findModelLimits([entry({ limit: limit as ModelLimitEntry["limit"] })], JEV),
      ).toBeUndefined();
    });
  }
});

describe("computeInputBudget", () => {
  test("applies the 25% reserve on a 200k window with a 32k output limit", () => {
    expect(ADVISOR_RESERVE_FRACTION).toBe(0.25);
    expect(computeInputBudget({ context: 200_000, output: 32_000 })).toBe(150_000);
  });

  test("lets the output limit force a reserve above 25%", () => {
    expect(computeInputBudget({ context: 200_000, output: 60_000 })).toBe(140_000);
  });

  test("never exceeds an advertised input limit", () => {
    expect(computeInputBudget({ context: 200_000, input: 100_000, output: 32_000 })).toBe(100_000);
  });

  test("takes the smaller of the input limit and the reserved window", () => {
    expect(computeInputBudget({ context: 200_000, input: 180_000, output: 32_000 })).toBe(150_000);
  });

  test("keeps the exact fractional reserve instead of flooring it", () => {
    expect(computeInputBudget({ context: 200_001, output: 32_000 })).toBe(150_000.75);
    expect(computeInputBudget({ context: 5, output: 1 })).toBe(3.75);
  });

  test("caps a fractional reserved window by the advertised input limit", () => {
    expect(computeInputBudget({ context: 5, input: 3, output: 1 })).toBe(3);
  });

  test("fails open when the reserve leaves no room", () => {
    expect(computeInputBudget({ context: 100_000, output: 150_000 })).toBeUndefined();
    expect(computeInputBudget({ context: 40_000, output: 40_000 })).toBeUndefined();
  });
});

describe("createModelLimitResolver", () => {
  test("resolves through the host catalog lookup", async () => {
    const calls: number[] = [];
    const resolve = createModelLimitResolver({
      list: async () => {
        calls.push(1);
        return { data: [entry()] };
      },
    });

    expect(await resolve(JEV)).toEqual({ context: 200_000, output: 32_000 });
    expect(calls).toHaveLength(1);
  });

  test("fails open when the catalog call throws", async () => {
    const resolve = createModelLimitResolver({
      list: async () => {
        throw new Error("host catalog unavailable");
      },
    });

    expect(await resolve(JEV)).toBeUndefined();
  });

  test("fails open when the catalog payload is malformed", async () => {
    const resolve = createModelLimitResolver({
      list: async () => ({}) as { readonly data?: readonly ModelLimitEntry[] },
    });

    expect(await resolve(JEV)).toBeUndefined();
  });

  test("fails open when the host exposes no catalog", async () => {
    expect(await createModelLimitResolver(undefined)(JEV)).toBeUndefined();
  });

  test("fails open when the model is missing from the catalog", async () => {
    const resolve = createModelLimitResolver({ list: async () => ({ data: [] }) });

    expect(await resolve(JEV)).toBeUndefined();
  });
});
