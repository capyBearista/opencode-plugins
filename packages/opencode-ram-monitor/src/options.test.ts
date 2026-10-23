import { describe, expect, test } from "bun:test";
import { parseOptions } from "./options.js";

describe("parseOptions", () => {
  test("uses the default interval when options are absent", () => {
    expect(parseOptions(undefined)).toEqual({
      refreshIntervalMs: 5000,
      layout: "full",
      warnings: [],
    });
    expect(parseOptions({})).toEqual({ refreshIntervalMs: 5000, layout: "full", warnings: [] });
  });

  test("accepts numeric intervals and numeric strings", () => {
    expect(parseOptions({ refreshIntervalMs: 2000 }).refreshIntervalMs).toBe(2000);
    expect(parseOptions({ refreshIntervalMs: "3000" }).refreshIntervalMs).toBe(3000);
    expect(parseOptions({ refreshIntervalMs: " 4000 " }).refreshIntervalMs).toBe(4000);
  });

  test("floors and clamps intervals to 1000..60000 without warning", () => {
    expect(parseOptions({ refreshIntervalMs: 2500.9 })).toEqual({
      refreshIntervalMs: 2500,
      layout: "full",
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
        layout: "full",
        warnings: ["refreshIntervalMs must be a number; using 5000"],
      });
    }
  });

  test("ignores unknown keys", () => {
    expect(parseOptions({ somethingElse: 1 })).toEqual({
      refreshIntervalMs: 5000,
      layout: "full",
      warnings: [],
    });
  });

  test("accepts the full and minimal layouts", () => {
    expect(parseOptions({ layout: "full" }).layout).toBe("full");
    expect(parseOptions({ layout: "minimal" }).layout).toBe("minimal");
  });

  test("falls back to the full layout with a warning for unknown layouts", () => {
    for (const layout of ["compact", "Minimal", "", 1, null, true]) {
      expect(parseOptions({ layout })).toEqual({
        refreshIntervalMs: 5000,
        layout: "full",
        warnings: ['layout must be "full" or "minimal"; using "full"'],
      });
    }
  });

  test("reports every unusable option", () => {
    expect(parseOptions({ refreshIntervalMs: "bad", layout: "tiny" }).warnings).toEqual([
      "refreshIntervalMs must be a number; using 5000",
      'layout must be "full" or "minimal"; using "full"',
    ]);
  });
});
