import { describe, expect, test } from "bun:test";
import { parseOptions } from "./options.js";

describe("parseOptions", () => {
  test("uses the default interval when options are absent", () => {
    expect(parseOptions(undefined)).toEqual({ refreshIntervalMs: 5000, warnings: [] });
    expect(parseOptions({})).toEqual({ refreshIntervalMs: 5000, warnings: [] });
  });

  test("accepts numeric intervals and numeric strings", () => {
    expect(parseOptions({ refreshIntervalMs: 2000 }).refreshIntervalMs).toBe(2000);
    expect(parseOptions({ refreshIntervalMs: "3000" }).refreshIntervalMs).toBe(3000);
    expect(parseOptions({ refreshIntervalMs: " 4000 " }).refreshIntervalMs).toBe(4000);
  });

  test("floors and clamps intervals to 1000..60000 without warning", () => {
    expect(parseOptions({ refreshIntervalMs: 2500.9 })).toEqual({
      refreshIntervalMs: 2500,
      warnings: [],
    });
    expect(parseOptions({ refreshIntervalMs: 0 }).refreshIntervalMs).toBe(1000);
    expect(parseOptions({ refreshIntervalMs: -500 }).refreshIntervalMs).toBe(1000);
    expect(parseOptions({ refreshIntervalMs: 999_999 }).refreshIntervalMs).toBe(60_000);
  });

  test("falls back to the default with a warning for unusable intervals", () => {
    for (const refreshIntervalMs of ["bad", "", "   ", null, true, Number.NaN, {}, []]) {
      expect(parseOptions({ refreshIntervalMs })).toEqual({
        refreshIntervalMs: 5000,
        warnings: ["refreshIntervalMs must be a number; using 5000"],
      });
    }
  });

  test("ignores unknown keys", () => {
    expect(parseOptions({ somethingElse: 1 })).toEqual({ refreshIntervalMs: 5000, warnings: [] });
  });
});
