import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeAssessment, RouterError } from "./router.js";
import { CONSEQUENCE_ANCHORS, CONSEQUENCE_MAX, CONSEQUENCE_MIN } from "./routing-types.js";

describe("normalizeAssessment", () => {
  test("clamps probabilities into [0, 1]", () => {
    expect(normalizeAssessment({ advisorWouldHelp: 1.5, consequence: 3 }).advisorWouldHelp).toBe(1);
    expect(normalizeAssessment({ advisorWouldHelp: -0.2, consequence: 3 }).advisorWouldHelp).toBe(
      0,
    );
    expect(
      normalizeAssessment({ advisorWouldHelp: Number.MAX_VALUE, consequence: 3 }).advisorWouldHelp,
    ).toBe(1);
    expect(
      normalizeAssessment({ advisorWouldHelp: -Number.MAX_VALUE, consequence: 3 }).advisorWouldHelp,
    ).toBe(0);
    expect(normalizeAssessment({ advisorWouldHelp: 0.55, consequence: 3 }).advisorWouldHelp).toBe(
      0.55,
    );
  });

  test("rejects non-finite probabilities as router errors", () => {
    for (const advisorWouldHelp of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => normalizeAssessment({ advisorWouldHelp, consequence: 3 })).toThrow(RouterError);
    }
  });

  test("accepts every integer consequence from 0 through 4", () => {
    for (const consequence of [0, 1, 2, 3, 4]) {
      expect(normalizeAssessment({ advisorWouldHelp: 0.5, consequence }).consequence).toBe(
        consequence,
      );
    }
  });

  test("rejects non-integer or out-of-range consequences as router errors", () => {
    for (const consequence of [2.5, -1, 5, Number.NaN]) {
      expect(() => normalizeAssessment({ advisorWouldHelp: 0.9, consequence })).toThrow(
        RouterError,
      );
    }
  });

  test("carries metadata through unchanged", () => {
    const metadata = { model: "jev-1.13", attempts: 2 };
    expect(normalizeAssessment({ advisorWouldHelp: 0.2, consequence: 1, metadata }).metadata).toBe(
      metadata,
    );
  });

  test("documents one consequence anchor per level", () => {
    expect(CONSEQUENCE_MIN).toBe(0);
    expect(CONSEQUENCE_MAX).toBe(4);
    expect(CONSEQUENCE_ANCHORS.map((anchor) => anchor.level)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(CONSEQUENCE_ANCHORS.map((anchor) => anchor.summary)).size).toBe(5);
    for (const anchor of CONSEQUENCE_ANCHORS) {
      expect(anchor.summary.length).toBeGreaterThan(0);
      expect(anchor.guidance.length).toBeGreaterThan(0);
    }
  });
});

describe("router boundary", () => {
  test("routing sources never import @opencode/ai or System One evaluation types", async () => {
    const directory = import.meta.dir;
    const files = [...new Bun.Glob("*.ts").scanSync({ cwd: directory })];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files.filter((name) => !name.includes(".test."))) {
      const source = await Bun.file(join(directory, file)).text();
      expect(source).not.toContain("@opencode/ai");
      expect(source).not.toContain("Evaluation");
      expect(source).not.toContain("System One");
    }
  });

  test("the package manifest does not depend on @opencode/ai", async () => {
    const manifest = await Bun.file(join(import.meta.dir, "..", "package.json")).text();
    expect(manifest).not.toContain("@opencode/ai");
  });
});
